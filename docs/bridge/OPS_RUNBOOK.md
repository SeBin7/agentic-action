# Bridge Ops Runbook

## 1) 사전 점검
```bash
python3 tools/bridge/healthcheck.py
cat bridge/state/health.json
```

`ok=true`일 때만 router가 inbox를 소비한다.
기본 healthcheck는 `codex exec --json --ephemeral` 경로를 사용한다.

기본 런타임 정책:
- `CODEX_HOME=$PWD/.runtime/codex_home` (project-local)
- 첫 실행 시 `~/.codex/auth.json`, `~/.codex/config.toml`이 있으면 자동 동기화
- 필요 시 모드 전환:
```bash
export BRIDGE_CODEX_HOME_MODE=home   # ~/.codex 직접 사용
```
- Codex worktree 기본 활성:
```bash
export BRIDGE_ENABLE_WORKTREE=1
```
- Gemini 자동 호출도 운영 게이트에 포함하려면:
```bash
export BRIDGE_REQUIRE_GEMINI=1
```

## 2) 작업 파일 투입
`bridge/inbox/`에 `.work.md` 파일을 생성한다.

기본 응답 언어는 한국어다. 영어 응답이 필요하면 frontmatter에 `response_lang: en`을 지정한다.
`to: gemini`로 넣으면 Gemini가 Codex용 후속 work 파일을 자동 생성한다.

실사용에서는 아래 제출 커맨드를 우선 사용한다:
```bash
tools/bridge/submit_work.py --to gemini --thread-id live "요청 문장" --run-once --wait
```
기본 후속 Codex 담당은 `@직원2`이며, 필요 시 `--codex-assign`으로 변경할 수 있다.

## 3) 실행
단발:
```bash
python3 tools/bridge/router.py run-once --workers 2
```

상주:
```bash
python3 tools/bridge/router.py daemon --interval 2 --workers 4
```

`submit_work.py`를 쓸 때의 권장 운영:
- 배치 모드: daemon 상주시 `--run-once` 없이 submit만 수행
- 즉시 실행 모드: daemon 없이 `--run-once --wait` 사용

## 4) 결과 확인
- 성공: `bridge/done/*.result.md`
- 실패: `bridge/error/*.error.md`
- 로그: `bridge/logs/*.log`
- 중복/처리 인덱스: `bridge/state/processed_index.json`
- 처리 완료된 원본 work 파일은 `bridge/inprogress/`에서 자동 제거된다.
- `to: gemini` 성공 시 `bridge/inbox/*_to_codex.work.md` 후속 작업 파일이 생성된다.

## 실사용 체크리스트
1. healthcheck
2. submit_work(gemini)
3. 결과 확인
4. 실패시 error 확인
5. PR 생성

## 5) 테스트용 워커 커맨드 오버라이드 (선택)
실제 `codex` 대신 지정 커맨드로 워커 동작만 검증하려면 아래 환경변수를 사용한다.

```bash
export BRIDGE_CODEX_CMD='bash -lc "echo BRIDGE_TEST_OK"'
python3 tools/bridge/router.py run-once
```

`{prompt}` 플레이스홀더를 넣으면 work 본문 프롬프트를 전달할 수 있다.

## 6) 테스트용 게이트 오버라이드 (선택)
네트워크 이슈로 healthcheck가 실패할 때, 게이트 경로만 검증하려면 healthcheck 커맨드를 임시 오버라이드한다.

```bash
export BRIDGE_HEALTHCHECK_CMD='bash -lc "echo BRIDGE_HEALTH_OK"'
python3 tools/bridge/healthcheck.py
```

## 7) 인증 안정화 체크
```bash
python3 tools/bridge/healthcheck.py
cat bridge/state/health.json
```

`reason`이 아래 중 하나면 인증 조치가 필요하다.
- `codex_auth_missing`
- `codex_auth_failed`

## 8) PR 자동 생성 (원격)
공식 GitHub CLI 인증 후 아래 스크립트로 push + PR 생성 가능:
```bash
tools/bridge/pr_submit.sh "feat: bridge update"
```
