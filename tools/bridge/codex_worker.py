#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Dict

from common import WorkerResult, codex_auth_status

PROFILE_PROMPTS = {
    "@직원1": "당신은 아키텍트/리뷰어입니다. 분석 중심으로 진행하고 코드 변경은 최소화하세요.",
    "@직원2": "당신은 구현 담당입니다. 구체적인 코드 변경과 검증 절차를 제시하세요.",
    "@직원3": "당신은 QA 담당입니다. 테스트 가능성, 회귀 위험, 실패 엣지케이스를 우선 점검하세요.",
}

RETRYABLE_ERRORS = {"timeout", "stream_disconnected", "exec_error", "non_zero"}


def _build_prompt(meta: Dict[str, object], body: str) -> str:
    assign = str(meta.get("assign", "@직원2"))
    profile = PROFILE_PROMPTS.get(assign, PROFILE_PROMPTS["@직원2"])
    response_lang = str(meta.get("response_lang", "ko")).strip().lower()
    if response_lang not in {"ko", "en"}:
        response_lang = "ko"
    if response_lang == "en":
        lang_rule = "Write all content in English."
    else:
        lang_rule = "모든 본문 내용은 한국어로 작성하세요."
    return (
        f"{profile}\n"
        "제공된 작업 파일을 처리하고 실행 가능한 결과를 간결하게 반환하세요.\n"
        "응답 섹션 제목은 반드시 RESULT, TEST, NEXT 순서를 유지하세요.\n"
        f"{lang_rule}\n"
        "불필요한 서론/메타설명 없이 결과만 작성하세요.\n\n"
        f"[META]\nthread_id={meta.get('thread_id')}\n"
        f"task_id={meta.get('task_id')}\n"
        f"assign={assign}\n"
        f"response_lang={response_lang}\n"
        f"priority={meta.get('priority')}\n\n"
        f"[WORK]\n{body.strip()}\n"
    )


def _parse_codex_jsonl(text: str) -> tuple[str, list[str]]:
    agent_messages: list[str] = []
    stream_errors: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        event_type = event.get("type")
        if event_type == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message":
                msg = str(item.get("text", "")).strip()
                if msg:
                    agent_messages.append(msg)
        elif event_type == "error":
            msg = str(event.get("message", "")).strip()
            if msg:
                stream_errors.append(msg)
    return ("\n\n".join(agent_messages)).strip(), stream_errors


def _has_auth_error(messages: list[str], stderr: str) -> bool:
    text = "\n".join(messages + [stderr]).lower()
    return "401 unauthorized" in text or "missing bearer" in text or "authentication" in text


def run_codex_once(
    *,
    repo_root: Path,
    meta: Dict[str, object],
    body: str,
    timeout_s: int,
    attempt: int,
    runtime_env: Dict[str, str],
) -> WorkerResult:
    start = time.monotonic()

    codex_bin = shutil.which("codex")
    if not codex_bin:
        elapsed = int((time.monotonic() - start) * 1000)
        return WorkerResult(
            ok=False,
            error_code="codex_not_found",
            error_stage="precheck",
            exit_code=None,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=False,
            stdout="",
            stderr="codex binary not found in PATH",
            raw_stdout="",
        )

    env = os.environ.copy()
    env.update(runtime_env)
    codex_home = Path(runtime_env["CODEX_HOME"])
    auth = codex_auth_status(codex_home)
    api_key_present = bool(env.get("OPENAI_API_KEY"))

    prompt = _build_prompt(meta, body)
    custom = os.environ.get("BRIDGE_CODEX_CMD", "").strip()
    use_json_stream = not custom
    if use_json_stream and not auth["auth_json"] and not api_key_present:
        elapsed = int((time.monotonic() - start) * 1000)
        return WorkerResult(
            ok=False,
            error_code="auth_missing",
            error_stage="auth",
            exit_code=None,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=False,
            stdout="",
            stderr=f"missing auth for CODEX_HOME={codex_home}. run `codex login` or provide OPENAI_API_KEY.",
            raw_stdout="",
        )

    if custom:
        parts = shlex.split(custom)
        cmd = [p.replace("{prompt}", prompt) for p in parts]
        if "{prompt}" not in custom:
            cmd.append(prompt)
    else:
        cmd = [
            codex_bin,
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--full-auto",
            prompt,
        ]

    try:
        proc = subprocess.run(
            cmd,
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed = int((time.monotonic() - start) * 1000)
        stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
        stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        return WorkerResult(
            ok=False,
            error_code="timeout",
            error_stage="exec",
            exit_code=None,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=True,
            stdout=stdout,
            stderr=stderr,
            raw_stdout=stdout,
        )
    except OSError as exc:
        elapsed = int((time.monotonic() - start) * 1000)
        return WorkerResult(
            ok=False,
            error_code="exec_error",
            error_stage="exec",
            exit_code=None,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=True,
            stdout="",
            stderr=str(exc),
            raw_stdout="",
        )

    elapsed = int((time.monotonic() - start) * 1000)
    raw_stdout = proc.stdout or ""
    stdout = raw_stdout
    stderr = proc.stderr or ""

    if use_json_stream:
        parsed_msg, stream_errors = _parse_codex_jsonl(raw_stdout)
        stdout = parsed_msg
        if _has_auth_error(stream_errors, stderr):
            return WorkerResult(
                ok=False,
                error_code="auth_failed",
                error_stage="auth",
                exit_code=proc.returncode,
                elapsed_ms=elapsed,
                retry_count=attempt,
                can_retry=False,
                stdout=stdout,
                stderr=stderr + ("\n" if stderr and stream_errors else "") + "\n".join(stream_errors),
                raw_stdout=raw_stdout,
            )
        if any("stream disconnected" in m.lower() for m in stream_errors):
            return WorkerResult(
                ok=False,
                error_code="stream_disconnected",
                error_stage="response_stream",
                exit_code=proc.returncode,
                elapsed_ms=elapsed,
                retry_count=attempt,
                can_retry=True,
                stdout=stdout,
                stderr=stderr + ("\n" if stderr and stream_errors else "") + "\n".join(stream_errors),
                raw_stdout=raw_stdout,
            )

    if "stream disconnected" in stderr.lower() or "stream disconnected" in stdout.lower():
        return WorkerResult(
            ok=False,
            error_code="stream_disconnected",
            error_stage="response_stream",
            exit_code=proc.returncode,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=True,
            stdout=stdout,
            stderr=stderr,
            raw_stdout=raw_stdout,
        )

    if proc.returncode != 0:
        if _has_auth_error([], stderr):
            return WorkerResult(
                ok=False,
                error_code="auth_failed",
                error_stage="auth",
                exit_code=proc.returncode,
                elapsed_ms=elapsed,
                retry_count=attempt,
                can_retry=False,
                stdout=stdout,
                stderr=stderr,
                raw_stdout=raw_stdout,
            )
        return WorkerResult(
            ok=False,
            error_code="non_zero",
            error_stage="exec",
            exit_code=proc.returncode,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=True,
            stdout=stdout,
            stderr=stderr,
            raw_stdout=raw_stdout,
        )

    if not stdout.strip():
        return WorkerResult(
            ok=False,
            error_code="empty_output",
            error_stage="postprocess",
            exit_code=proc.returncode,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=False,
            stdout=stdout,
            stderr=stderr,
            raw_stdout=raw_stdout,
        )

    return WorkerResult(
        ok=True,
        error_code=None,
        error_stage=None,
        exit_code=proc.returncode,
        elapsed_ms=elapsed,
        retry_count=attempt,
        can_retry=False,
        stdout=stdout,
        stderr=stderr,
        raw_stdout=raw_stdout,
    )


def is_retryable(result: WorkerResult) -> bool:
    if result.error_code is None:
        return False
    return result.error_code in RETRYABLE_ERRORS and result.can_retry
