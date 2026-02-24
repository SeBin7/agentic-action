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
