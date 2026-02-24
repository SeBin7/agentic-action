#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Promote PR chain: integration PR -> main PR -> CD run check")
    p.add_argument("--integration-pr", type=int, default=2, help="먼저 머지할 하위 PR 번호 (default: 2)")
    p.add_argument("--main-pr", type=int, default=1, help="main 대상 상위 PR 번호 (default: 1)")
    p.add_argument("--merge-method", choices=("merge", "squash", "rebase"), default="merge")
    p.add_argument("--wait-check-timeout", type=int, default=900)
    p.add_argument("--wait-cd-timeout", type=int, default=900)
    p.add_argument("--poll-seconds", type=int, default=5)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def run(cmd: List[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if check and proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nstdout={proc.stdout}\nstderr={proc.stderr}")
    return proc


def gh_json(args: List[str]) -> Any:
    proc = run(["gh", *args], check=True)
    out = proc.stdout.strip()
    if not out:
        return None
    return json.loads(out)


def parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def ensure_prereqs() -> None:
    if shutil.which("gh") is None:
        raise RuntimeError("gh not found")
    auth = run(["gh", "auth", "status"])
    if auth.returncode != 0:
        raise RuntimeError("gh auth not ready. run: gh auth login")


def pr_info(number: int) -> Dict[str, Any]:
    fields = [
        "number",
        "title",
        "state",
        "url",
        "baseRefName",
        "headRefName",
        "headRefOid",
        "mergeStateStatus",
        "isDraft",
        "mergedAt",
        "statusCheckRollup",
    ]
    return gh_json(["pr", "view", str(number), "--json", ",".join(fields)])


def checks_summary(pr: Dict[str, Any]) -> Dict[str, Any]:
    rows = pr.get("statusCheckRollup") or []
    if not rows:
        return {"total": 0, "completed": 0, "success": 0, "pending": 0, "failed": 0}

    total = len(rows)
    completed = 0
    success = 0
    pending = 0
    failed = 0

    for row in rows:
        status = str(row.get("status") or "").upper()
        conclusion = str(row.get("conclusion") or "").upper()
        if status == "COMPLETED":
            completed += 1
            if conclusion in {"SUCCESS", "SKIPPED", "NEUTRAL"}:
                success += 1
            else:
                failed += 1
        else:
            pending += 1

    return {
        "total": total,
        "completed": completed,
        "success": success,
        "pending": pending,
        "failed": failed,
    }


def wait_pr_checks_success(pr_number: int, timeout_s: int, poll_s: int) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        info = pr_info(pr_number)
        summary = checks_summary(info)

        if summary["total"] == 0:
            # 체크가 없으면 일단 통과로 간주 (브랜치 정책에서 막으면 merge 단계에서 다시 실패)
            print(f"[check] pr#{pr_number}: no checks")
            return

        if summary["failed"] > 0:
            raise RuntimeError(f"pr#{pr_number} checks failed: {summary}")

        if summary["pending"] == 0 and summary["completed"] == summary["total"]:
            print(f"[check] pr#{pr_number}: all checks passed")
            return

        print(f"[check] pr#{pr_number}: waiting {summary}")
        time.sleep(max(1, poll_s))

    raise RuntimeError(f"timeout waiting pr#{pr_number} checks")


def merge_pr(pr_number: int, merge_method: str, dry_run: bool = False) -> None:
    if dry_run:
        print(f"[dry-run] gh pr merge {pr_number} --{merge_method}")
        return

    cmd = ["gh", "pr", "merge", str(pr_number), f"--{merge_method}", "--delete-branch=false"]
    proc = run(cmd)
    if proc.returncode != 0:
        # 이미 merge된 경우는 통과
        info = pr_info(pr_number)
        if str(info.get("state")) == "MERGED":
            print(f"[merge] pr#{pr_number} already merged")
            return
        raise RuntimeError(f"failed merging pr#{pr_number}: {proc.stderr or proc.stdout}")
    print(f"[merge] pr#{pr_number} merged")


def wait_head_updated(pr_number: int, before_oid: str, timeout_s: int, poll_s: int) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        info = pr_info(pr_number)
        oid = str(info.get("headRefOid") or "")
        if oid and oid != before_oid:
            print(f"[sync] pr#{pr_number} head updated: {before_oid[:8]} -> {oid[:8]}")
            return oid
        time.sleep(max(1, poll_s))
    raise RuntimeError(f"timeout waiting pr#{pr_number} head update")


def wait_cd_after(merged_at: datetime, timeout_s: int, poll_s: int) -> Dict[str, Any]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        runs = gh_json(
            [
                "run",
                "list",
                "--workflow",
                "cd",
                "--branch",
                "main",
                "--limit",
                "20",
                "--json",
                "databaseId,workflowName,status,conclusion,createdAt,url,displayTitle",
            ]
        )
        if not isinstance(runs, list):
            runs = []

        candidate: Optional[Dict[str, Any]] = None
        for row in runs:
            created = str(row.get("createdAt") or "")
            if not created:
                continue
            created_dt = parse_iso(created)
            if created_dt >= merged_at:
                candidate = row
                break

        if candidate is None:
            print("[cd] waiting for cd run to appear...")
            time.sleep(max(1, poll_s))
            continue

        status = str(candidate.get("status") or "").lower()
        conclusion = str(candidate.get("conclusion") or "").lower()
        print(f"[cd] run={candidate.get('databaseId')} status={status} conclusion={conclusion}")
        if status == "completed":
            return candidate

        time.sleep(max(1, poll_s))

    raise RuntimeError("timeout waiting cd run completion")


def main() -> int:
    args = parse_args()
    try:
        ensure_prereqs()

        integ = pr_info(args.integration_pr)
        top = pr_info(args.main_pr)

        if args.dry_run:
            print(
                f"[dry-run] plan: merge pr#{args.integration_pr} ({integ.get('headRefName')} -> {integ.get('baseRefName')})"
            )
            print(f"[dry-run] plan: merge pr#{args.main_pr} ({top.get('headRefName')} -> {top.get('baseRefName')})")
            print("[dry-run] plan: wait CD run on main")
            return 0

        if str(integ.get("state")) == "MERGED":
            print(f"[info] integration pr#{args.integration_pr} already merged")
        else:
            wait_pr_checks_success(args.integration_pr, args.wait_check_timeout, args.poll_seconds)
            merge_pr(args.integration_pr, args.merge_method, dry_run=args.dry_run)

        top_before_oid = str(top.get("headRefOid") or "")
        if top_before_oid:
            wait_head_updated(args.main_pr, top_before_oid, args.wait_check_timeout, args.poll_seconds)

        top = pr_info(args.main_pr)
        if str(top.get("state")) == "MERGED":
            print(f"[info] main pr#{args.main_pr} already merged")
            merged_at = parse_iso(str(top.get("mergedAt"))) if top.get("mergedAt") else now_utc()
        else:
            wait_pr_checks_success(args.main_pr, args.wait_check_timeout, args.poll_seconds)
            merge_pr(args.main_pr, args.merge_method, dry_run=args.dry_run)
            top = pr_info(args.main_pr)
            merged_at = parse_iso(str(top.get("mergedAt"))) if top.get("mergedAt") else now_utc()

        cd_run = wait_cd_after(merged_at, args.wait_cd_timeout, args.poll_seconds)
        conclusion = str(cd_run.get("conclusion") or "").lower()
        print(f"[done] cd run: {cd_run.get('url')}")
        if conclusion in {"success", "neutral", "skipped"}:
            return 0
        return 1

    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
