# Bridge Troubleshooting

## gate blocked
증상:
- router 실행 시 `[gate] blocked: ...`

대응:
1. `python3 tools/bridge/healthcheck.py` 재실행
2. `bridge/state/health.json`의 `reason` 확인

## codex_timeout
증상:
- healthcheck 또는 work 실행이 timeout

대응:
1. 네트워크 상태 확인
2. 재시도 정책(`max_retries`) 점검
3. 필요 시 timeout_s 상향

## gemini_not_found
증상:
- healthcheck `reason=gemini_not_found`

대응:
1. Gemini CLI 설치 여부 확인 (`which gemini`)
2. `BRIDGE_REQUIRE_GEMINI=1`을 끄고 Codex-only 경로부터 복구
3. Gemini CLI 로그인/실행 상태 복구 후 재검증

## codex_stream_disconnected
증상:
- healthcheck `reason=codex_stream_disconnected`
- `bridge/error/*.error.md`에 `error_code=stream_disconnected`

대응:
1. 인터넷/DNS 경로 확인
2. 짧은 재시도 대신 간격을 늘려 재실행
3. 임시 검증은 `BRIDGE_HEALTHCHECK_CMD` 오버라이드로 게이트 동작만 확인

## codex_auth_failed
증상:
- healthcheck `reason=codex_auth_failed`
- `bridge/error/*.error.md`에 `error_code=auth_failed`

대응:
1. codex CLI 로그인 상태 확인
2. 실행 셸의 인증 토큰/환경 변수 전달 상태 확인
3. 인증 복구 전에는 `BRIDGE_HEALTHCHECK_CMD`로 파이프라인 구조만 검증

## codex_auth_missing
증상:
- healthcheck `reason=codex_auth_missing`
- `bridge/error/*.error.md`에 `error_code=auth_missing`

대응:
1. `codex login` 수행
2. `~/.codex/auth.json` 존재 확인
3. project-local 사용 시 자동 동기화가 안 되면 `BRIDGE_CODEX_HOME_MODE=home`으로 전환 후 재시도

## empty_output
증상:
- `.error.md`에 `error_code=empty_output`

대응:
1. `bridge/logs/*.stdout.log` 확인
2. codex exec 출력 포맷 변동 여부 점검

## duplicate skip
증상:
- 동일 thread/task 재투입 시 처리되지 않음

대응:
1. `bridge/state/processed_index.json`에서 키 확인
2. 새 `task_id`로 재발행

## worktree_create_failed
증상:
- `.error.md` 또는 stderr에 `[worktree] worktree_create_failed:...`

대응:
1. `git worktree list`로 상태 점검
2. 충돌 브랜치/경로 정리 후 재시도
3. 임시 우회: `BRIDGE_ENABLE_WORKTREE=0`

## gh가 auth 명령을 모를 때
증상:
- `gh auth login` 실행 시 `No such command "auth"`

원인:
- 공식 GitHub CLI가 아니라 `gitsome`의 `gh`가 설치됨

대응:
1. `which gh` 확인
2. `gh --help`에 `Main entry point for GitHubCli`가 나오면 gitsome 제거
3. 공식 GitHub CLI 설치 후 `gh auth login`
