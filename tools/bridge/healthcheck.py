#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from common import codex_auth_status, runtime_env


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[2]


def ensure(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def parse_jsonl_agent_message(text: str) -> tuple[str, list[str]]:
    messages: list[str] = []
    errors: list[str] = []
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
                    messages.append(msg)
        elif event_type == "error":
            msg = str(event.get("message", "")).strip()
            if msg:
                errors.append(msg)
    return ("\n\n".join(messages)).strip(), errors


def has_auth_error(messages: list[str], stderr: str) -> bool:
    text = "\n".join(messages + [stderr]).lower()
    return "401 unauthorized" in text or "missing bearer" in text or "authentication" in text


def main() -> int:
    root = repo_root_from_here()
    state_dir = root / "bridge" / "state"
    ensure(state_dir)

    report = {
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ok": False,
        "reason": "unknown",
        "checks": {},
    }

    codex_bin = shutil.which("codex")
    report["checks"]["codex_exists"] = bool(codex_bin)
    if not codex_bin:
        report["reason"] = "codex_not_found"
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[health] codex binary not found")
        return 1

    env = os.environ.copy()
    forced_env = runtime_env(root)
    env.update(forced_env)
    report["checks"]["runtime_env"] = forced_env
    auth = codex_auth_status(Path(forced_env["CODEX_HOME"]))
    report["checks"]["codex_auth_files"] = auth
    report["checks"]["openai_api_key_present"] = bool(env.get("OPENAI_API_KEY"))

    custom = os.environ.get("BRIDGE_HEALTHCHECK_CMD", "").strip()
    if custom:
        cmd = shlex.split(custom)
        use_json_stream = False
    else:
        cmd = [
            codex_bin,
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--full-auto",
            "Print exactly: BRIDGE_HEALTH_OK",
        ]
        use_json_stream = True

    if use_json_stream and not auth["auth_json"] and not env.get("OPENAI_API_KEY"):
        report["reason"] = "codex_auth_missing"
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[health] codex auth missing")
        return 1
    try:
        proc = subprocess.run(
            cmd,
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except subprocess.TimeoutExpired:
        report["reason"] = "codex_timeout"
        report["checks"]["smoke_timeout_s"] = 20
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[health] codex smoke timeout")
        return 1
    except OSError as exc:
        report["reason"] = "codex_exec_error"
        report["checks"]["exec_error"] = str(exc)
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"[health] codex exec error: {exc}")
        return 1

    raw_stdout = proc.stdout or ""
    stdout = raw_stdout
    stderr = proc.stderr or ""
    stream_errors: list[str] = []
    if use_json_stream:
        parsed, stream_errors = parse_jsonl_agent_message(raw_stdout)
        stdout = parsed

    report["checks"]["smoke_exit_code"] = proc.returncode
    report["checks"]["smoke_stdout_non_empty"] = bool(stdout.strip())
    report["checks"]["smoke_stdout_tail"] = "\n".join(raw_stdout.splitlines()[-20:])
    report["checks"]["smoke_stderr_tail"] = "\n".join(stderr.splitlines()[-20:])
    if stream_errors:
        report["checks"]["smoke_stream_errors"] = stream_errors

    if has_auth_error(stream_errors, stderr):
        report["reason"] = "codex_auth_failed"
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[health] codex auth failed")
        return 1

    if any("stream disconnected" in m.lower() for m in stream_errors):
        report["reason"] = "codex_stream_disconnected"
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[health] codex stream disconnected")
        return 1

    if proc.returncode == 0 and stdout.strip():
        report["ok"] = True
        report["reason"] = "ok"
        (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[health] ok")
        return 0

    report["reason"] = "codex_smoke_failed"
    (state_dir / "health.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("[health] failed")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
