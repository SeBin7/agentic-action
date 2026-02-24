# Role Split + Multi Sub-Agent + Worktree Runbook

## 1. 역할 분리 정책
- 정책 파일: `bridge/config/role_policy.json`
- 기본 lane:
  - `codex`: `src/**`, `tests/**`, `package*.json`, `.github/workflows/**`
  - `gemini`: `docs/**`, `tools/bridge/**`, `bridge/config/**`
- `assign_overrides`로 lane별 예외 경로를 열 수 있습니다.

## 2. Work Item 필드
- `to`: `codex` | `gemini`
- `assign`: 서브에이전트 프로필(`@직원1`, `@직원2`, `@직원3`)
- `work_mode`:
  - `confirm`: 요약/확정/지시 생성 모드
  - `code`: 실제 코드 수정 모드
- `scope_paths`(선택): `src/**,tests/**` 형태 glob

## 3. 병렬 웨이브 실행
1) healthcheck
```bash
python3 tools/bridge/healthcheck.py
```
2) plan 기반 병렬 실행(2 workers)
```bash
python3 tools/bridge/run_role_wave.py \
  --plan-file docs/bridge/examples/role_wave_plan.sample.json \
  --workers 2
```

## 4. Worktree 확인
- 각 결과 frontmatter의 `work_dir`, `work_branch` 확인
- 감사 로그: `bridge/state/attempt_audit.jsonl`

## 5. 병합 리허설(충돌 검증)
### 5-1) 스레드 기반 자동 브랜치 수집
```bash
python3 tools/bridge/merge_rehearsal.py --thread-id <thread_id>
```
### 5-2) 브랜치 직접 지정
```bash
python3 tools/bridge/merge_rehearsal.py \
  --base <base-branch> \
  --branch bridge/codex/<...> \
  --branch bridge/gemini/<...>
```
- `status=clean`: 충돌 없음
- `status=conflict`: 충돌 파일 목록 출력

## 6. PR 승격 체인 자동화 (#2 -> #1 -> main -> CD)
```bash
python3 tools/bridge/promote_chain.py \
  --integration-pr 2 \
  --main-pr 1 \
  --merge-method merge
```
- 동작:
  - 하위 PR(예: #2) 체크 통과 확인 후 머지
  - 상위 PR(예: #1) head 갱신/체크 통과 확인 후 main 머지
  - main push 이후 CD run 생성/완료까지 대기

## 7. 강제 규칙
- `scope_paths` 또는 `role_policy` 밖 변경은 `scope_violation` 에러 처리
- `gemini + work_mode=confirm`에서 파일 변경이 발생하면 `unexpected_changes` 처리
