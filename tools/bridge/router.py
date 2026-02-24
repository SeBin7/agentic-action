#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

from codex_worker import is_retryable as is_codex_retryable
from codex_worker import run_codex_once
from common import (
    now_utc_iso,
    now_utc_stamp,
    parse_work_file,
    render_markdown,
    runtime_env,
    save_json,
    load_json,
    validate_work_meta,
    thread_task_key,
    tail,
    write_text,
    ensure_dir,
    WorkerResult,
)
from gemini_worker import is_retryable as is_gemini_retryable
from gemini_worker import run_gemini_once


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def bridge_dirs(root: Path) -> Dict[str, Path]:
    base = root / "bridge"
    return {
        "base": base,
        "inbox": base / "inbox",
        "inprogress": base / "inprogress",
        "done": base / "done",
        "error": base / "error",
        "locks": base / "locks",
        "logs": base / "logs",
        "state": base / "state",
    }


def ensure_layout(root: Path) -> Dict[str, Path]:
    dirs = bridge_dirs(root)
    for p in dirs.values():
        ensure_dir(p)
    return dirs


def load_health(state_dir: Path) -> Dict[str, Any]:
    return load_json(state_dir / "health.json", default={"ok": False, "reason": "missing_health"})


def load_index(state_dir: Path) -> Dict[str, Any]:
    return load_json(state_dir / "processed_index.json", default={"processed": {}})


def save_index(state_dir: Path, idx: Dict[str, Any]) -> None:
    save_json(state_dir / "processed_index.json", idx)


def list_inbox(inbox: Path) -> List[Path]:
    return sorted(inbox.glob("*.work.md"))


def output_path(out_dir: Path, meta: Dict[str, Any], actor: str, suffix: str) -> Path:
    thread_id = str(meta.get("thread_id"))
    task_id = str(meta.get("task_id"))
    stamp = now_utc_stamp()
    return out_dir / f"{stamp}_{thread_id}_{task_id}_from_{actor}.{suffix}.md"


def unique_work_path(inbox: Path, thread_id: str, task_id: str, target: str) -> Path:
    stamp = now_utc_stamp()
    base = f"{stamp}_{thread_id}_{task_id}_to_{target}.work.md"
    path = inbox / base
    if not path.exists():
        return path
    for i in range(1, 1000):
        path = inbox / f"{stamp}_{thread_id}_{task_id}_{i:03d}_to_{target}.work.md"
        if not path.exists():
            return path
    raise RuntimeError("unable to allocate unique work file name")


def log_path(logs_dir: Path, work_stem: str, attempt: int, stream: str) -> Path:
    return logs_dir / f"{work_stem}.attempt{attempt}.{stream}.log"


def build_success_doc(meta: Dict[str, Any], result: WorkerResult, followup: Path | None = None) -> str:
    front: Dict[str, Any] = {
        "kind": "result",
        "thread_id": meta.get("thread_id"),
        "task_id": meta.get("task_id"),
        "from": result.actor,
        "to": "router",
        "assign": meta.get("assign"),
        "status": "done",
        "exit_code": result.exit_code if result.exit_code is not None else 0,
        "elapsed_ms": result.elapsed_ms,
        "retries": result.retry_count,
        "created_at": now_utc_iso(),
    }
    if result.work_dir:
        front["work_dir"] = result.work_dir

    lines = ["# RESULT", result.stdout.strip() or "(no summary)", ""]
    if followup is not None:
        lines.extend(
            [
                "# FOLLOWUP",
                f"- created_work: {followup}",
                "- 라우터가 후속 Codex 작업 파일을 inbox에 자동 생성했다.",
                "",
            ]
        )
    lines.extend(
        [
            "# NEXT",
            "- 사람이 결과를 검토하고 다음 작업 파일 발행 여부를 결정한다.",
        ]
    )
    return render_markdown(front, "\n".join(lines))


def build_error_doc(meta: Dict[str, Any], result: WorkerResult) -> str:
    front: Dict[str, Any] = {
        "kind": "error",
        "thread_id": meta.get("thread_id"),
        "task_id": meta.get("task_id"),
        "from": result.actor,
        "to": "router",
        "assign": meta.get("assign"),
        "status": "error",
        "error_code": result.error_code or "unknown",
        "error_stage": result.error_stage or "unknown",
        "retry_count": result.retry_count,
        "can_retry": result.can_retry,
        "created_at": now_utc_iso(),
    }
    if result.work_dir:
        front["work_dir"] = result.work_dir
    body = "\n".join(
        [
            "# ERROR",
            f"- error_code: {result.error_code or 'unknown'}",
            f"- error_stage: {result.error_stage or 'unknown'}",
            f"- retry_count: {result.retry_count}",
            f"- can_retry: {str(result.can_retry).lower()}",
            "",
            "# STDERR_TAIL",
            "```text",
            (tail(result.stderr, 80) or "(empty)"),
            "```",
        ]
    )
    return render_markdown(front, body)


def cleanup_inprogress(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def record_index(
    idx_lock: threading.Lock,
    idx: Dict[str, Any],
    state_dir: Path,
    key: str,
    payload: Dict[str, Any],
) -> None:
    with idx_lock:
        idx.setdefault("processed", {})[key] = payload
        save_index(state_dir, idx)


def is_duplicate(idx_lock: threading.Lock, idx: Dict[str, Any], key: str) -> bool:
    with idx_lock:
        return key in idx.get("processed", {})


def should_retry(target: str, result: WorkerResult) -> bool:
    if target == "gemini":
        return is_gemini_retryable(result)
    return is_codex_retryable(result)


def wrap_as_codex_body(text: str) -> str:
    t = text.strip()
    if "# TASK" in t and "# CONTEXT" in t and "# REQUIREMENTS" in t and "# OUTPUT" in t:
        return t + "\n"
    return (
        "# TASK\n"
        "Gemini 생성 지시를 Codex 실행 작업으로 처리한다.\n\n"
        "# CONTEXT\n"
        "- Gemini auto output raw text를 전달받음.\n\n"
        "# REQUIREMENTS\n"
        "- 아래 RAW 내용을 기준으로 필요한 코드/문서 작업을 수행한다.\n\n"
        "# OUTPUT\n"
        "- 변경 요약, 검증 결과, 다음 단계 제안.\n\n"
        "# NOTES\n"
        "```text\n"
        f"{t}\n"
        "```\n"
    )


def create_codex_followup(dirs: Dict[str, Path], meta: Dict[str, Any], gemini_output: str) -> Path:
    thread_id = str(meta.get("thread_id"))
    task_id = str(meta.get("task_id"))
    follow_meta = {
        "kind": "work",
        "thread_id": thread_id,
        "task_id": task_id,
        "from": "gemini",
        "to": "codex",
        "assign": str(meta.get("codex_assign", meta.get("assign", "@직원2"))),
        "priority": meta.get("priority", "high"),
        "status": "new",
        "timeout_s": int(meta.get("codex_timeout_s", meta.get("timeout_s", 240))),
        "max_retries": int(meta.get("codex_max_retries", meta.get("max_retries", 3))),
        "response_lang": meta.get("response_lang", "ko"),
        "created_at": now_utc_iso(),
    }
    body = wrap_as_codex_body(gemini_output)
    out = unique_work_path(dirs["inbox"], thread_id, task_id, "codex")
    write_text(out, render_markdown(follow_meta, body))
    return out


def claim_inbox_files(dirs: Dict[str, Path]) -> List[Path]:
    claimed: List[Path] = []
    for src in list_inbox(dirs["inbox"]):
        dst = dirs["inprogress"] / src.name
        try:
            src.rename(dst)
            claimed.append(dst)
        except FileNotFoundError:
            continue
        except OSError as exc:
            print(f"[claim] skip:{src.name}:{exc}")
    return claimed


def run_target_once(
    *,
    target: str,
    repo_root: Path,
    meta: Dict[str, Any],
    body: str,
    timeout_s: int,
    attempt: int,
    env: Dict[str, str],
) -> WorkerResult:
    if target == "gemini":
        return run_gemini_once(
            repo_root=repo_root,
            meta=meta,
            body=body,
            timeout_s=timeout_s,
            attempt=attempt,
        )
    return run_codex_once(
        repo_root=repo_root,
        meta=meta,
        body=body,
        timeout_s=timeout_s,
        attempt=attempt,
        runtime_env=env,
    )


def process_claimed_work(
    repo_root: Path,
    dirs: Dict[str, Path],
    inprogress_path: Path,
    idx: Dict[str, Any],
    idx_lock: threading.Lock,
) -> Tuple[str, bool]:
    try:
        item = parse_work_file(inprogress_path)
    except Exception as exc:
        cleanup_inprogress(inprogress_path)
        return f"error_parse:{inprogress_path.name}:{exc}", True

    meta = item.meta
    target = str(meta.get("to", "")).strip().lower() or "unknown"
    key = thread_task_key(meta)

    if is_duplicate(idx_lock, idx, key):
        duplicate = WorkerResult(
            ok=False,
            error_code="duplicate_task",
            error_stage="dedupe",
            exit_code=None,
            elapsed_ms=0,
            retry_count=0,
            can_retry=False,
            stdout="",
            stderr=f"duplicate key already processed: {key}",
            actor=target,
            work_dir=str(repo_root),
        )
        err_out = output_path(dirs["error"], meta, target, "error")
        write_text(err_out, build_error_doc(meta, duplicate))
        cleanup_inprogress(inprogress_path)
        return f"skip_duplicate:{inprogress_path.name}:{target}", True

    errors = validate_work_meta(meta)
    if errors:
        invalid = WorkerResult(
            ok=False,
            error_code="invalid_workfile",
            error_stage="validation",
            exit_code=None,
            elapsed_ms=0,
            retry_count=0,
            can_retry=False,
            stdout="",
            stderr="\n".join(errors),
            actor=target,
            work_dir=str(repo_root),
        )
        err_out = output_path(dirs["error"], meta, target, "error")
        write_text(err_out, build_error_doc(meta, invalid))
        record_index(
            idx_lock,
            idx,
            dirs["state"],
            key,
            {
                "status": "error",
                "error_code": "invalid_workfile",
                "at": now_utc_iso(),
                "source": str(inprogress_path),
                "output": str(err_out),
            },
        )
        cleanup_inprogress(inprogress_path)
        return f"error_invalid:{inprogress_path.name}:{target}", True

    max_retries = int(meta.get("max_retries", 1))
    timeout_s = int(meta.get("timeout_s", 240))
    env = runtime_env(repo_root)

    last: WorkerResult | None = None
    for attempt in range(1, max_retries + 1):
        result = run_target_once(
            target=target,
            repo_root=repo_root,
            meta=meta,
            body=item.body,
            timeout_s=timeout_s,
            attempt=attempt,
            env=env,
        )
        last = result
        write_text(
            log_path(dirs["logs"], inprogress_path.stem, attempt, f"{target}.stdout"),
            result.raw_stdout if result.raw_stdout else result.stdout,
        )
        write_text(
            log_path(dirs["logs"], inprogress_path.stem, attempt, f"{target}.stderr"),
            result.stderr,
        )

        if result.ok:
            followup: Path | None = None
            if target == "gemini":
                followup = create_codex_followup(dirs, meta, result.stdout)
            done_out = output_path(dirs["done"], meta, target, "result")
            write_text(done_out, build_success_doc(meta, result, followup))
            record_index(
                idx_lock,
                idx,
                dirs["state"],
                key,
                {
                    "status": "done",
                    "actor": target,
                    "at": now_utc_iso(),
                    "source": str(inprogress_path),
                    "output": str(done_out),
                    "followup": str(followup) if followup else None,
                },
            )
            cleanup_inprogress(inprogress_path)
            return f"done:{inprogress_path.name}:{target}", True

        if attempt < max_retries and should_retry(target, result):
            time.sleep(min(2**attempt, 7))
            continue
        break

    final = last or WorkerResult(
        ok=False,
        error_code="unknown",
        error_stage="unknown",
        exit_code=None,
        elapsed_ms=0,
        retry_count=max_retries,
        can_retry=False,
        stdout="",
        stderr="unknown worker failure",
        actor=target,
        work_dir=str(repo_root),
    )
    err_out = output_path(dirs["error"], meta, target, "error")
    write_text(err_out, build_error_doc(meta, final))
    record_index(
        idx_lock,
        idx,
        dirs["state"],
        key,
        {
            "status": "error",
            "actor": target,
            "error_code": final.error_code or "unknown",
            "at": now_utc_iso(),
            "source": str(inprogress_path),
            "output": str(err_out),
        },
    )
    cleanup_inprogress(inprogress_path)
    return f"error:{inprogress_path.name}:{target}", True


def run_once(repo_root: Path, workers: int) -> int:
    dirs = ensure_layout(repo_root)
    health = load_health(dirs["state"])
    if not health.get("ok", False):
        reason = health.get("reason", "health_not_ok")
        print(f"[gate] blocked: {reason}")
        return 0

    claimed = claim_inbox_files(dirs)
    if not claimed:
        return 0

    idx = load_index(dirs["state"])
    idx_lock = threading.Lock()
    processed = 0
    max_workers = max(1, workers)

    if max_workers == 1:
        for path in claimed:
            msg, counted = process_claimed_work(repo_root, dirs, path, idx, idx_lock)
            print(f"[work] {msg}")
            if counted:
                processed += 1
        return processed

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        fut_to_path = {
            pool.submit(process_claimed_work, repo_root, dirs, path, idx, idx_lock): path
            for path in claimed
        }
        for fut in as_completed(fut_to_path):
            path = fut_to_path[fut]
            try:
                msg, counted = fut.result()
                print(f"[work] {msg}")
                if counted:
                    processed += 1
            except Exception as exc:  # safety net
                print(f"[work] crash:{path.name}:{exc}")
    return processed


def main() -> int:
    parser = argparse.ArgumentParser(description="File Bridge Router")
    sub = parser.add_subparsers(dest="cmd", required=True)

    try:
        default_workers = max(1, int(os.environ.get("BRIDGE_WORKERS", "1")))
    except ValueError:
        default_workers = 1

    r = sub.add_parser("run-once")
    r.add_argument("--workers", type=int, default=default_workers)

    d = sub.add_parser("daemon")
    d.add_argument("--interval", type=int, default=2)
    d.add_argument("--workers", type=int, default=default_workers)

    args = parser.parse_args()
    root = repo_root_from_here()

    if args.cmd == "run-once":
        processed = run_once(root, workers=max(1, args.workers))
        print(f"[summary] processed={processed}")
        return 0

    interval = max(1, args.interval)
    workers = max(1, args.workers)
    print(f"[daemon] started interval={interval}s workers={workers}")
    try:
        while True:
            processed = run_once(root, workers=workers)
            print(f"[tick] processed={processed}")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("[daemon] stopped")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
