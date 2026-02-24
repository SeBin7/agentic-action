---
title: File Bridge Router Plan (Gemini → Codex)
created_at: 2026-02-23
owner: 세빈
status: draft
---

# 목적
기존 `scheduler.py + handoff 큐` 기반 오케스트레이션이 불안정했던 이유를 정리하고, **파일 브릿지/라우터(File Bridge Router)** 방식으로
- Gemini(지시/할당) → Codex(실행)
- “캐치해서 바로 실행” 체감
을 만들기 위한 **작업 파일(Work File) 규약**과 **동작 흐름**을 확정한다.

---

# TL;DR (결론)
- **CLI 창만 여러 개 띄워놓는 것**으로는 서로 메시지를 “자동 캐치”할 수 없다(프로세스 격리).
- 대신 **공유 디렉토리(파일)**를 “단톡방”으로 쓰면, 실시간에 가까운 **브릿지/라우터** 구현이 가능하다.
- 기존 오케스트레이션 실패는 “연결 불가”가 아니라, 대부분 **Codex CLI 런타임 불안정(권한/스트림/빈 출력) + 상태관리(턴 제한/중복처리)** 문제였다.
- 파일 브릿지는 상태/규약을 단순화하고, 실패를 구조화하여 **회복 가능(재시도/에러 파일 분리)** 하게 만든다.

---

# 1) 기존 오케스트레이션이 실패한 이유(핵심 정리)

## 1.1 실행기(Codex CLI) 런타임 이슈가 치명적
대표적으로 이런 패턴이 발생했다(세션 로그 기준):
- `~/.codex/... Permission denied (os error 13)` : 로컬 상태/스냅샷/임시파일 쓰기 실패
- `stream disconnected before completion` : 네트워크/세션 스트림 끊김
- `no last agent message` / stdout empty : 결과 파일이 비거나 출력 포맷이 흔들림

=> 결과적으로 “오케스트레이터가 잘 분배해도” **워커가 결과를 못 내서 파이프가 멈춤**.

## 1.2 상태 관리 부수 규칙이 많아 디버깅이 어려움
`scheduler.py` 류는 보통 다음이 섞인다:
- `status:new` 같은 frontmatter 규칙
- processed hash(dedupe)
- thread별 turn limit (`max_turns_default=6` 등)
- 큐 디렉토리/런타임 디렉토리 정합성

=> 어느 단계에서 멈췄는지 “체감상 안됨”이 발생.

## 1.3 “CLI끼리 직접 대화”로 착각하기 쉬움
Gemini CLI / Codex CLI는 서로의 stdout을 구독하지 않는다.
따라서 단순히 두 CLI 창이 열려있다고 해서 “서로 캐치”는 기본적으로 불가능.

---

# 2) 지금 구상한 브릿지/라우터의 정확한 의미

## 2.1 용어 정의
- **브릿지(Bridge)**: 한쪽 출력(또는 사람이 만든 입력)을 감지해서 다른 쪽이 소비할 수 있는 형태로 전달하는 중계층
- **라우터(Router)**: `ASSIGN:@직원2` 같은 라벨을 읽고, “어떤 실행 프로필(직원)”로 Codex를 돌릴지 결정하는 분배 로직
- **워커(Worker)**: 실제로 `codex exec ...` 같은 실행을 수행하는 실행기(Executor)

> 핵심: Gemini↔Codex가 직접 통신하는 게 아니라, **브릿지/라우터가 중간에서 파일을 통해 릴레이**한다.

## 2.2 파일 브릿지의 장점
- Redis 같은 외부 컴포넌트 없이 바로 구현 가능(설치 최소)
- 상태가 단순(파일 1개 = 작업 1개)
- 실패를 `*.error.md`로 분리 가능 → 무한 루프 방지/원인 추적 쉬움
- `inotify`(Linux) 또는 폴링으로 “실시간 캐치” 느낌을 만들 수 있음

---

# 3) 파일 브릿지 디렉토리 구조(제안)
프로젝트 루트 기준:

```
bridge/
  inbox/            # Gemini → Router 로 들어오는 작업 파일
  inprogress/       # 처리 중(락/이동)
  done/             # 성공 결과(응답/산출물 포인터)
  error/            # 실패 결과(에러/로그)
  locks/            # 락 파일(optional)
  logs/             # 워커 stderr/stdout 로그(optional)
```

---

# 4) “Codex가 작업할 수 있는 작업 파일(Work File)” 규약

## 4.1 파일명 규칙
- `YYYYMMDDTHHMMSSZ_<thread>_<taskid>_to_codex.work.md`
- 예: `20260223T071500Z_trend-oss-real-service-v4_0001_to_codex.work.md`

## 4.2 Frontmatter(필수)
```yaml
---
kind: work
thread_id: trend-oss-real-service-v4
task_id: "0001"
from: gemini
to: codex
assign: "@직원2"          # 라우터가 선택할 실행 프로필
priority: high
status: new               # new -> inprogress -> done|error
timeout_s: 240
max_retries: 3
created_at: 2026-02-23T07:15:00Z
---
```

## 4.3 Body(필수 섹션)
아래 섹션은 **파싱/자동화**를 위해 고정한다.

```md
# TASK
(한 줄 요약)

# CONTEXT
- (필요한 파일/경로/참고 링크)
- (현재 상태, 제약)

# REQUIREMENTS
- (필수 요구사항 bullet)

# OUTPUT
- (원하는 산출물: patch, 파일 생성, 설명 등)
- (테스트/검증 조건)

# NOTES
- (추가 힌트, 금지 사항 등)
```

## 4.4 Codex 응답 파일 규약(출력)
Codex 워커는 아래 형식으로 `done/`에 결과 파일을 만든다.

- `YYYYMMDDTHHMMSSZ_<thread>_<taskid>_from_codex.result.md`

Frontmatter 예:
```yaml
---
kind: result
thread_id: trend-oss-real-service-v4
task_id: "0001"
from: codex
to: router
assign: "@직원2"
status: done
exit_code: 0
elapsed_ms: 53211
retries: 1
created_at: 2026-02-23T07:16:20Z
---
```

Body 예:
```md
# RESULT
- (무엇을 했는지 요약)

# PATCH
```diff
(필요 시 diff)
```

# TEST
- (실행한 테스트/명령)
- (결과)

# NEXT
- (추가 작업 필요 시)
```

실패 시는 `error/`로:
- `..._from_codex.error.md`
- `stderr_tail` 또는 로그 파일 경로 포함

---

# 5) 라우터 동작(파일 브릿지 시퀀스)

## 5.1 기본 흐름
1) Gemini가 작업을 생성: `bridge/inbox/*.work.md`
2) Router가 감지:
   - `status:new` 확인
   - `assign` 파싱(`@직원1/2/3`)
3) Router가 `inprogress/`로 원자적 이동(락)
4) Codex Worker 실행:
   - profile(@직원N)에 맞는 프롬프트/작업공간(worktree)/권한 정책 적용
   - `codex exec ...` 실행
5) 결과 생성:
   - 성공: `done/*.result.md`
   - 실패: `error/*.error.md`
6) 필요하면 Router가 결과를 다시 Gemini에게 “followup 작업 파일”로 생성(선택)

## 5.2 @직원 라우팅(프로필 테이블)
라우터가 아래처럼 매핑한다(예시):

- `@직원1` : Architect/Reviewer (설계/리뷰 위주, 코드 수정 최소)
- `@직원2` : Implementer (코드 작성/패치 생성)
- `@직원3` : QA (테스트/엣지케이스/리팩토링 제안)

> 구현상: 프로필별로 “프롬프트 템플릿 + 작업 디렉토리(worktree) + 허용 파일 범위”를 다르게 준다.

---

# 6) 기존 오케스트레이션 대비, 파일 브릿지가 “성공할” 조건
파일 브릿지 자체는 단순해서 라우팅은 잘 된다. 성공을 좌우하는 건 결국 **Codex 워커 안정화**다.

Codex 워커에 최소로 들어가야 할 안정화:
1) 환경 강제:
   - `TMPDIR=/tmp`
   - `XDG_CACHE_HOME=/tmp/xdg-cache`
   - `XDG_CONFIG_HOME=/tmp/xdg-config`
   - `XDG_STATE_HOME=/tmp/xdg-state`
2) `~/.codex` 권한 헬스체크(가능하면 자동 복구)
3) `stream disconnected` 패턴 재시도(backoff: 1s, 3s, 7s)
4) stdout empty면 즉시 error 처리(원인 로그 포함)
5) 타임아웃 강제 + 강제 종료 + 재시도

---

# 7) “지금 바로 Codex가 작업할 수 있는” 샘플 Work File
아래 파일을 그대로 `bridge/inbox/`에 넣으면 라우터가 잡아갈 수 있다.

```md
---
kind: work
thread_id: trend-oss-real-service-v4
task_id: "0001"
from: gemini
to: codex
assign: "@직원2"
priority: high
status: new
timeout_s: 240
max_retries: 3
created_at: 2026-02-23T07:15:00Z
---

# TASK
프로젝트에서 Codex 워커가 파일 브릿지 작업 파일을 자동 처리하도록 최소 라우터/워커 스크립트를 만든다.

# CONTEXT
- 목표: `bridge/inbox/*.work.md` 감지 → `codex exec` 실행 → `bridge/done/*.result.md` 생성
- 외부 의존성 없이(Linux) 동작
- 실행 결과는 `bridge/logs/`에 남길 것

# REQUIREMENTS
- work file frontmatter 파싱: thread_id, task_id, assign, timeout_s, max_retries
- status:new 파일만 처리
- 처리 시작 시 inprogress로 이동(원자적)
- codex 실행 실패 시 error md 생성( stderr tail 포함)
- 성공 시 result md 생성(무엇을 했는지 + 다음 단계)

# OUTPUT
- 파일: `tools/bridge/router.py`, `tools/bridge/codex_worker.py`
- 실행 가이드: `README_bridge.md`
- 테스트 방법: 더미 work 파일 1개로 end-to-end 확인

# NOTES
- `@직원2` 프로필은 구현 담당. 프롬프트는 “patch + test” 중심으로.
```

---

# 8) 참고: 업로드 파일 만료 이슈
이 문서는 “개념/규약”을 기준으로 작성되었고, 이전에 업로드된 일부 파일은 세션에서 만료될 수 있다.

---

# 9) 적용 상태 (2026-02-24)
- `Gemini 자동 호출`: `to: gemini` work를 Router가 자동 처리하고 `to: codex` 후속 work를 inbox에 생성
- `멀티워커/병렬`: `router.py run-once|daemon --workers N` 지원
- `worktree`: Codex 실행 시 기본 `git worktree` 사용(`BRIDGE_ENABLE_WORKTREE=1`)
- `원격 PR 생성`: `tools/bridge/pr_submit.sh` 추가(gh 충돌/인증 검사 포함)
- `실사용 입력`: `tools/bridge/submit_work.py`로 지시문 -> work 생성 -> run-once/wait 연동 지원
기존 코드(scheduler/run_*.sh/env)와 1:1로 맞춘 패치가 필요하면 해당 파일을 다시 업로드해야 한다.

---

# 다음 단계(실행)
1) 위 디렉토리 구조 생성: `bridge/{inbox,inprogress,done,error,locks,logs}`
2) 라우터/워커 구현(폴링 또는 inotify)
3) 샘플 work 파일을 `bridge/inbox/`에 넣고 end-to-end로 결과 확인

## 구현 기준 문서
- 본 설계의 구현 기준은 `docs/bridge/WORKFILE_SPEC.md`를 따른다.
