#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

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
)
from codex_worker import run_codex_once, is_retryable


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


def output_path(out_dir: Path, meta: Dict[str, Any], suffix: str) -> Path:
    thread_id = str(meta.get("thread_id"))
    task_id = str(meta.get("task_id"))
    stamp = now_utc_stamp()
    return out_dir / f"{stamp}_{thread_id}_{task_id}_from_codex.{suffix}.md"


def log_path(logs_dir: Path, work_stem: str, attempt: int, stream: str) -> Path:
    return logs_dir / f"{work_stem}.attempt{attempt}.{stream}.log"


def build_success_doc(meta: Dict[str, Any], result: str, elapsed_ms: int, retries: int, exit_code: int) -> str:
    front = {
        "kind": "result",
        "thread_id": meta.get("thread_id"),
        "task_id": meta.get("task_id"),
        "from": "codex",
        "to": "router",
        "assign": meta.get("assign"),
        "status": "done",
        "exit_code": exit_code,
        "elapsed_ms": elapsed_ms,
        "retries": retries,
        "created_at": now_utc_iso(),
    }
    body = "\n".join(
        [
            "# RESULT",
            result.strip() or "(no summary)",
            "",
            "# NEXT",
            "- 사람이 결과를 검토하고 다음 작업 파일 발행 여부를 결정한다.",
        ]
    )
    return render_markdown(front, body)


def build_error_doc(meta: Dict[str, Any], err_code: str, err_stage: str, stderr_tail: str, retry_count: int, can_retry: bool) -> str:
    front = {
        "kind": "error",
        "thread_id": meta.get("thread_id"),
        "task_id": meta.get("task_id"),
        "from": "codex",
        "to": "router",
        "assign": meta.get("assign"),
        "status": "error",
        "error_code": err_code,
        "error_stage": err_stage,
        "retry_count": retry_count,
        "can_retry": can_retry,
        "created_at": now_utc_iso(),
    }
    body = "\n".join(
        [
            "# ERROR",
            f"- error_code: {err_code}",
            f"- error_stage: {err_stage}",
            f"- retry_count: {retry_count}",
            f"- can_retry: {str(can_retry).lower()}",
            "",
            "# STDERR_TAIL",
            "```text",
            (stderr_tail or "(empty)"),
            "```",
        ]
    )
    return render_markdown(front, body)


def cleanup_inprogress(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        # Keep queue processing resilient even if cleanup fails.
        pass


def process_one_work(repo_root: Path, dirs: Dict[str, Path], work_path: Path) -> str:
    idx = load_index(dirs["state"])
    item = parse_work_file(work_path)
    inprogress_path = dirs["inprogress"] / work_path.name

    errors = validate_work_meta(item.meta)
    key = thread_task_key(item.meta)
    if key in idx.get("processed", {}):
        work_path.rename(inprogress_path)
        err_out = output_path(dirs["error"], item.meta, "error")
        err_doc = build_error_doc(
            item.meta,
            err_code="duplicate_task",
            err_stage="dedupe",
            stderr_tail=f"duplicate key already processed: {key}",
            retry_count=0,
            can_retry=False,
        )
        write_text(err_out, err_doc)
        cleanup_inprogress(inprogress_path)
        return f"skip_duplicate:{work_path.name}"

    if errors:
        work_path.rename(inprogress_path)
        err_out = output_path(dirs["error"], item.meta, "error")
        err_doc = build_error_doc(
            item.meta,
            err_code="invalid_workfile",
            err_stage="validation",
            stderr_tail="\n".join(errors),
            retry_count=0,
            can_retry=False,
        )
        write_text(err_out, err_doc)
        idx.setdefault("processed", {})[key] = {
            "status": "error",
            "error_code": "invalid_workfile",
            "at": now_utc_iso(),
            "source": str(inprogress_path),
            "output": str(err_out),
        }
        save_index(dirs["state"], idx)
        cleanup_inprogress(inprogress_path)
        return f"error_invalid:{work_path.name}"

    work_path.rename(inprogress_path)

    max_retries = int(item.meta.get("max_retries", 1))
    timeout_s = int(item.meta.get("timeout_s", 240))
    env = runtime_env(repo_root)

    last = None
    for attempt in range(1, max_retries + 1):
        result = run_codex_once(
            repo_root=repo_root,
            meta=item.meta,
            body=item.body,
            timeout_s=timeout_s,
            attempt=attempt,
            runtime_env=env,
        )
        last = result
        write_text(
            log_path(dirs["logs"], inprogress_path.stem, attempt, "stdout"),
            result.raw_stdout if result.raw_stdout else result.stdout,
        )
        write_text(log_path(dirs["logs"], inprogress_path.stem, attempt, "stderr"), result.stderr)

        if result.ok:
            done_out = output_path(dirs["done"], item.meta, "result")
            done_doc = build_success_doc(
                item.meta,
                result=result.stdout,
                elapsed_ms=result.elapsed_ms,
                retries=attempt,
                exit_code=result.exit_code if result.exit_code is not None else 0,
            )
            write_text(done_out, done_doc)
            idx.setdefault("processed", {})[key] = {
                "status": "done",
                "at": now_utc_iso(),
                "source": str(inprogress_path),
                "output": str(done_out),
            }
            save_index(dirs["state"], idx)
            cleanup_inprogress(inprogress_path)
            return f"done:{inprogress_path.name}"

        if attempt < max_retries and is_retryable(result):
            time.sleep(min(2 ** attempt, 7))
            continue
        break

    if last is None:
        return f"error_unknown:{inprogress_path.name}"

    err_out = output_path(dirs["error"], item.meta, "error")
    err_doc = build_error_doc(
        item.meta,
        err_code=last.error_code or "unknown",
        err_stage=last.error_stage or "unknown",
        stderr_tail=tail(last.stderr, 80),
        retry_count=last.retry_count,
        can_retry=False,
    )
    write_text(err_out, err_doc)
    idx.setdefault("processed", {})[key] = {
        "status": "error",
        "error_code": last.error_code or "unknown",
        "at": now_utc_iso(),
        "source": str(inprogress_path),
        "output": str(err_out),
    }
    save_index(dirs["state"], idx)
    cleanup_inprogress(inprogress_path)
    return f"error:{inprogress_path.name}"


def run_once(repo_root: Path) -> int:
    dirs = ensure_layout(repo_root)
    health = load_health(dirs["state"])
    if not health.get("ok", False):
        reason = health.get("reason", "health_not_ok")
        print(f"[gate] blocked: {reason}")
        return 0

    processed = 0
    for work in list_inbox(dirs["inbox"]):
        try:
            result = process_one_work(repo_root, dirs, work)
            print(f"[work] {result}")
            if result.startswith("done:") or result.startswith("error:"):
                processed += 1
        except Exception as exc:  # safety net for queue progress
            print(f"[work] crash:{work.name}:{exc}")
    return processed


def main() -> int:
    parser = argparse.ArgumentParser(description="File Bridge Router")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("run-once")
    d = sub.add_parser("daemon")
    d.add_argument("--interval", type=int, default=2)

    args = parser.parse_args()
    root = repo_root_from_here()

    if args.cmd == "run-once":
        processed = run_once(root)
        print(f"[summary] processed={processed}")
        return 0

    interval = max(1, args.interval)
    print(f"[daemon] started interval={interval}s")
    try:
        while True:
            processed = run_once(root)
            print(f"[tick] processed={processed}")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("[daemon] stopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
