#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Dict

from common import WorkerResult

PROFILE_PROMPTS = {
    "@직원1": "당신은 기획/리뷰 역할입니다. 실행 지시를 명확하고 보수적으로 작성하세요.",
    "@직원2": "당신은 구현 지시 역할입니다. Codex가 바로 실행할 수 있는 작업 지시로 변환하세요.",
    "@직원3": "당신은 QA 기획 역할입니다. 테스트 관점과 검증 조건을 우선 반영하세요.",
}

RETRYABLE_ERRORS = {"timeout", "exec_error", "non_zero"}


def _build_prompt(meta: Dict[str, object], body: str) -> str:
    assign = str(meta.get("assign", "@직원2"))
    profile = PROFILE_PROMPTS.get(assign, PROFILE_PROMPTS["@직원2"])
    response_lang = str(meta.get("response_lang", "ko")).strip().lower()
    if response_lang not in {"ko", "en"}:
        response_lang = "ko"

    lang_line = (
        "Write all content in English."
        if response_lang == "en"
        else "모든 본문은 한국어로 작성하세요."
    )
    return (
        f"{profile}\n"
        "아래 요청을 Codex 실행용 Work Body로 변환하세요.\n"
        "반드시 마크다운 본문만 출력하고 frontmatter는 출력하지 마세요.\n"
        "섹션은 반드시 '# TASK', '# CONTEXT', '# REQUIREMENTS', '# OUTPUT', '# NOTES' 순서로 작성하세요.\n"
        f"{lang_line}\n"
        "불필요한 서론/사과/메타 설명은 금지합니다.\n\n"
        f"[META]\nthread_id={meta.get('thread_id')}\n"
        f"task_id={meta.get('task_id')}\n"
        f"assign={assign}\n"
        f"priority={meta.get('priority')}\n\n"
        f"[REQUEST]\n{body.strip()}\n"
    )


def run_gemini_once(
    *,
    repo_root: Path,
    meta: Dict[str, object],
    body: str,
    timeout_s: int,
    attempt: int,
) -> WorkerResult:
    start = time.monotonic()
    work_dir = repo_root

    gemini_bin = shutil.which("gemini")
    if not gemini_bin:
        elapsed = int((time.monotonic() - start) * 1000)
        return WorkerResult(
            ok=False,
            error_code="gemini_not_found",
            error_stage="precheck",
            exit_code=None,
            elapsed_ms=elapsed,
            retry_count=attempt,
            can_retry=False,
            stdout="",
            stderr="gemini binary not found in PATH",
            raw_stdout="",
            actor="gemini",
            work_dir=str(work_dir),
        )

    prompt = _build_prompt(meta, body)
    custom = os.environ.get("BRIDGE_GEMINI_CMD", "").strip()
    if custom:
        parts = shlex.split(custom)
        cmd = [p.replace("{prompt}", prompt) for p in parts]
        if "{prompt}" not in custom:
            cmd.append(prompt)
    else:
        cmd = [
            gemini_bin,
            "-p",
            prompt,
            "--approval-mode",
            "yolo",
            "--output-format",
            "text",
        ]

    try:
        proc = subprocess.run(
            cmd,
            cwd=work_dir,
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
            actor="gemini",
            work_dir=str(work_dir),
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
            actor="gemini",
            work_dir=str(work_dir),
        )

    elapsed = int((time.monotonic() - start) * 1000)
    stdout = (proc.stdout or "").strip()
    stderr = proc.stderr or ""
    if proc.returncode != 0:
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
            raw_stdout=proc.stdout or "",
            actor="gemini",
            work_dir=str(work_dir),
        )

    if not stdout:
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
            raw_stdout=proc.stdout or "",
            actor="gemini",
            work_dir=str(work_dir),
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
        raw_stdout=proc.stdout or "",
        actor="gemini",
        work_dir=str(work_dir),
    )


def is_retryable(result: WorkerResult) -> bool:
    if result.error_code is None:
        return False
    return result.error_code in RETRYABLE_ERRORS and result.can_retry

