#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Tuple

from common import (
    ensure_dir,
    load_json,
    now_utc_iso,
    now_utc_stamp,
    parse_frontmatter,
    read_text,
    render_markdown,
    save_json,
    write_text,
)


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


def next_task_id(state_path: Path, thread_id: str) -> str:
    state = load_json(state_path, default={"thread_counters": {}})
    counters = state.setdefault("thread_counters", {})
    current = int(counters.get(thread_id, 0)) + 1
    counters[thread_id] = current
    save_json(state_path, state)
    return f"{current:04d}"


def build_body(target: str, text: str, notes: str | None) -> str:
    base_req = "- 결과는 실행 가능한 형태로 작성한다."
    if target == "gemini":
        base_req = "- Codex가 바로 실행 가능한 작업 본문으로 변환한다."
    lines = [
        "# TASK",
        text.strip(),
        "",
        "# CONTEXT",
        "- submitted_by: tools/bridge/submit_work.py",
        f"- target: {target}",
        "",
        "# REQUIREMENTS",
        base_req,
        "",
        "# OUTPUT",
        "- RESULT, TEST, NEXT 기준으로 정리한다.",
    ]
    if notes:
        lines.extend(["", "# NOTES", notes.strip()])
    return "\n".join(lines) + "\n"


def unique_inbox_path(inbox: Path, thread_id: str, task_id: str, target: str) -> Path:
    stamp = now_utc_stamp()
    candidate = inbox / f"{stamp}_{thread_id}_{task_id}_to_{target}.work.md"
    if not candidate.exists():
        return candidate
    for i in range(1, 1000):
        c = inbox / f"{stamp}_{thread_id}_{task_id}_{i:03d}_to_{target}.work.md"
        if not c.exists():
            return c
    raise RuntimeError("unable to allocate work file path")


def read_meta(path: Path) -> Dict[str, Any]:
    meta, _ = parse_frontmatter(read_text(path))
    return meta


def find_result(
    dirs: Dict[str, Path],
    thread_id: str,
    task_id: str,
    expected_actor: str,
) -> Tuple[str, Path] | None:
    for p in sorted(dirs["done"].glob("*.result.md"), reverse=True):
        try:
            meta = read_meta(p)
        except Exception:
            continue
        if str(meta.get("thread_id")) == thread_id and str(meta.get("task_id")) == task_id:
            actor = str(meta.get("from", ""))
            if actor == expected_actor:
                return ("done", p)

    for p in sorted(dirs["error"].glob("*.error.md"), reverse=True):
        try:
            meta = read_meta(p)
        except Exception:
            continue
        if str(meta.get("thread_id")) == thread_id and str(meta.get("task_id")) == task_id:
            actor = str(meta.get("from", ""))
            if actor == expected_actor:
                return ("error", p)
    return None


def run_router_once(repo_root: Path, workers: int) -> int:
    cmd = [
        sys.executable,
        str(repo_root / "tools" / "bridge" / "router.py"),
        "run-once",
        "--workers",
        str(max(1, workers)),
    ]
    proc = subprocess.run(cmd, cwd=repo_root, text=True, capture_output=True, check=False)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    return proc.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Submit a bridge work item for real usage flow.")
    parser.add_argument("text", nargs="*", help="지시문. 비워두면 --text-file 또는 stdin 사용")
    parser.add_argument("--to", choices=("gemini", "codex"), default="gemini")
    parser.add_argument("--thread-id", default="manual")
    parser.add_argument("--task-id", default="")
    parser.add_argument("--assign", default="")
    parser.add_argument("--priority", default="high")
    parser.add_argument("--timeout-s", type=int, default=240)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--response-lang", choices=("ko", "en"), default="ko")
    parser.add_argument("--notes", default="")
    parser.add_argument("--text-file", default="")
    parser.add_argument("--run-once", action="store_true", help="생성 직후 router run-once 실행")
    parser.add_argument("--ticks", type=int, default=0, help="run-once 반복 횟수 (0이면 to별 기본값)")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--wait", action="store_true", help="최종 결과(don/error)까지 대기")
    parser.add_argument("--wait-timeout", type=int, default=180)
    args = parser.parse_args()

    repo_root = repo_root_from_here()
    dirs = ensure_layout(repo_root)

    text = " ".join(args.text).strip()
    if args.text_file:
        text = read_text(Path(args.text_file)).strip()
    if not text:
        stdin_text = sys.stdin.read().strip()
        text = stdin_text
    if not text:
        print("[error] 지시문이 비어 있습니다.", file=sys.stderr)
        return 2

    thread_id = args.thread_id.strip() or "manual"
    if args.task_id.strip():
        task_id = args.task_id.strip()
    else:
        task_id = next_task_id(dirs["state"] / "submit_state.json", thread_id)

    assign = args.assign.strip()
    if not assign:
        assign = "@직원1" if args.to == "gemini" else "@직원2"

    meta = {
        "kind": "work",
        "thread_id": thread_id,
        "task_id": task_id,
        "from": "human",
        "to": args.to,
        "assign": assign,
        "priority": args.priority,
        "status": "new",
        "timeout_s": int(args.timeout_s),
        "max_retries": int(args.max_retries),
        "response_lang": args.response_lang,
        "created_at": now_utc_iso(),
    }
    body = build_body(args.to, text, args.notes or None)
    work_path = unique_inbox_path(dirs["inbox"], thread_id, task_id, args.to)
    write_text(work_path, render_markdown(meta, body))
    print(f"[submit] created={work_path}")

    ticks = args.ticks
    if ticks <= 0:
        ticks = 2 if args.to == "gemini" else 1

    if args.run_once:
        for i in range(ticks):
            rc = run_router_once(repo_root, workers=max(1, args.workers))
            if rc != 0:
                print(f"[run-once] non_zero={rc} tick={i+1}/{ticks}", file=sys.stderr)
                return rc

    if args.wait:
        expected_actor = "codex" if args.to == "gemini" else args.to
        start = time.time()
        while time.time() - start <= max(1, args.wait_timeout):
            found = find_result(dirs, thread_id, task_id, expected_actor)
            if found is not None:
                status, path = found
                print(f"[result] status={status} actor={expected_actor} path={path}")
                print(read_text(path))
                return 0 if status == "done" else 1
            time.sleep(1)
        print("[result] timeout waiting for final result", file=sys.stderr)
        return 124

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

