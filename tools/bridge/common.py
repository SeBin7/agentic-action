#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Tuple

REQUIRED_FRONTMATTER_KEYS = {
    "kind",
    "thread_id",
    "task_id",
    "from",
    "to",
    "assign",
    "priority",
    "status",
    "timeout_s",
    "max_retries",
    "created_at",
}

ALLOWED_TARGET_AGENTS = {"codex", "gemini"}


@dataclass
class WorkItem:
    path: Path
    meta: Dict[str, Any]
    body: str


@dataclass
class WorkerResult:
    ok: bool
    error_code: str | None
    error_stage: str | None
    exit_code: int | None
    elapsed_ms: int
    retry_count: int
    can_retry: bool
    stdout: str
    stderr: str
    raw_stdout: str = ""
    actor: str = "codex"
    work_dir: str = ""


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def now_utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, data: str) -> None:
    ensure_dir(path.parent)
    path.write_text(data, encoding="utf-8")


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def save_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def parse_scalar(value: str) -> Any:
    raw = value.strip()
    lowered = raw.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "none"}:
        return None
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        return raw[1:-1]
    if raw.isdigit():
        return int(raw)
    return raw


def parse_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter start")

    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        raise ValueError("missing frontmatter end")

    meta: Dict[str, Any] = {}
    for line in lines[1:end]:
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"invalid frontmatter line: {line}")
        key, value = line.split(":", 1)
        meta[key.strip()] = parse_scalar(value)

    body = "\n".join(lines[end + 1 :]).strip() + "\n"
    return meta, body


def render_frontmatter(meta: Dict[str, Any]) -> str:
    ordered = []
    for key in sorted(meta.keys()):
        value = meta[key]
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif value is None:
            rendered = "null"
        elif isinstance(value, (int, float)):
            rendered = str(value)
        else:
            s = str(value)
            # Keep pure-digit strings quoted to preserve identifiers like "0003".
            if any(ch in s for ch in [":", "#"]) or s.strip() != s or s.isdigit():
                rendered = json.dumps(s, ensure_ascii=False)
            else:
                rendered = s
        ordered.append(f"{key}: {rendered}")
    return "---\n" + "\n".join(ordered) + "\n---\n"


def render_markdown(meta: Dict[str, Any], body: str) -> str:
    return render_frontmatter(meta) + "\n" + body.rstrip() + "\n"


def validate_work_meta(meta: Dict[str, Any]) -> list[str]:
    missing = sorted(REQUIRED_FRONTMATTER_KEYS - set(meta.keys()))
    errors = [f"missing_key:{m}" for m in missing]

    status = str(meta.get("status", "")).strip().lower()
    if status != "new":
        errors.append(f"invalid_status:{status}")

    if str(meta.get("kind", "")).strip().lower() != "work":
        errors.append("invalid_kind")

    to_agent = str(meta.get("to", "")).strip().lower()
    if to_agent not in ALLOWED_TARGET_AGENTS:
        errors.append(f"invalid_to:{to_agent}")

    for numeric in ("timeout_s", "max_retries"):
        v = meta.get(numeric)
        if not isinstance(v, int):
            errors.append(f"invalid_{numeric}")
        elif v <= 0:
            errors.append(f"non_positive_{numeric}")

    return errors


def parse_work_file(path: Path) -> WorkItem:
    meta, body = parse_frontmatter(read_text(path))
    return WorkItem(path=path, meta=meta, body=body)


def thread_task_key(meta: Dict[str, Any]) -> str:
    target = str(meta.get("to", "")).strip().lower()
    return f"{meta.get('thread_id')}::{meta.get('task_id')}::{target}"


def _is_truthy(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


def codex_auth_status(codex_home: Path) -> Dict[str, bool]:
    return {
        "auth_json": (codex_home / "auth.json").exists(),
        "config_toml": (codex_home / "config.toml").exists(),
    }


def _sync_codex_auth(target_home: Path, source_home: Path) -> None:
    if not source_home.exists():
        return
    for name in ("auth.json", "config.toml"):
        src = source_home / name
        dst = target_home / name
        if src.exists() and not dst.exists():
            ensure_dir(dst.parent)
            shutil.copy2(src, dst)
            try:
                os.chmod(dst, 0o600)
            except OSError:
                pass


def runtime_env(repo_root: Path) -> Dict[str, str]:
    base = repo_root / ".runtime"
    home_codex = Path.home() / ".codex"
    mode = os.environ.get("BRIDGE_CODEX_HOME_MODE", "project").strip().lower()
    if mode in {"home", "user"}:
        codex_home = home_codex
    else:
        codex_home = base / "codex_home"

    env = {
        "CODEX_HOME": str(codex_home),
        "TMPDIR": str(base / "tmp"),
        "XDG_CACHE_HOME": str(base / "xdg-cache"),
        "XDG_CONFIG_HOME": str(base / "xdg-config"),
        "XDG_STATE_HOME": str(base / "xdg-state"),
        # Avoid inheriting network-disabled flag from orchestrator shells.
        "CODEX_SANDBOX_NETWORK_DISABLED": "0",
    }
    for key in ("CODEX_HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"):
        ensure_dir(Path(env[key]))

    # Default behavior keeps project-local CODEX_HOME and auto-syncs auth.
    should_sync = _is_truthy(os.environ.get("BRIDGE_CODEX_AUTH_SYNC"), default=True)
    source_home = Path(os.environ.get("BRIDGE_CODEX_AUTH_SOURCE", str(home_codex)))
    if mode not in {"home", "user"} and should_sync:
        _sync_codex_auth(codex_home, source_home)

    return env


def slugify(value: object, fallback: str = "x", max_len: int = 48) -> str:
    s = str(value or "").strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-.")
    if not s:
        s = fallback
    return s[:max_len]


def prepare_git_worktree(repo_root: Path, meta: Dict[str, Any]) -> Tuple[Path, str | None]:
    enabled = _is_truthy(os.environ.get("BRIDGE_ENABLE_WORKTREE"), default=True)
    if not enabled:
        return repo_root, None

    git_bin = shutil.which("git")
    if not git_bin:
        return repo_root, "git_not_found"

    in_git = subprocess.run(
        [git_bin, "-C", str(repo_root), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
        check=False,
    )
    if in_git.returncode != 0:
        return repo_root, "not_git_repo"

    base = repo_root / ".runtime" / "worktrees"
    ensure_dir(base)

    thread = slugify(meta.get("thread_id"), fallback="thread")
    task = slugify(meta.get("task_id"), fallback="task")
    assign = slugify(meta.get("assign"), fallback="agent")
    wt_name = slugify(f"{thread}-{task}-{assign}", fallback="worktree", max_len=90)
    wt_path = base / wt_name
    if wt_path.exists():
        return wt_path, None

    branch = f"bridge/{thread}/{task}/{assign}"
    has_branch = subprocess.run(
        [git_bin, "-C", str(repo_root), "show-ref", "--verify", f"refs/heads/{branch}"],
        capture_output=True,
        text=True,
        check=False,
    ).returncode == 0

    if has_branch:
        cmd = [git_bin, "-C", str(repo_root), "worktree", "add", str(wt_path), branch]
    else:
        cmd = [git_bin, "-C", str(repo_root), "worktree", "add", "-b", branch, str(wt_path), "HEAD"]

    created = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if created.returncode != 0:
        err = (created.stderr or created.stdout or "").strip()
        return repo_root, f"worktree_create_failed:{tail(err, 10)}"
    return wt_path, None


def tail(text: str, max_lines: int = 40) -> str:
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    return "\n".join(lines[-max_lines:])
