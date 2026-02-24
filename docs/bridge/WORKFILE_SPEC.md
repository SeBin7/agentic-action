# Work File Specification (Bridge v1)

## 입력 파일 패턴
`bridge/inbox/YYYYMMDDTHHMMSSZ_<thread>_<taskid>_to_codex.work.md`

## 필수 Frontmatter 키
- `kind`
- `thread_id`
- `task_id`
- `from`
- `to`
- `assign`
- `priority`
- `status`
- `timeout_s`
- `max_retries`
- `created_at`

## 선택 Frontmatter 키
- `response_lang` (`ko`|`en`, 기본값: `ko`)

## 필수 값 규칙
- `kind: work`
- `to: codex | gemini`
- `status: new`
- `timeout_s > 0`
- `max_retries > 0`

## Body 섹션
- `# TASK`
- `# CONTEXT`
- `# REQUIREMENTS`
- `# OUTPUT`
- `# NOTES` (선택)

## 상태 전이
- `new -> inprogress -> done|error`
- 처리 시작 시 `inbox -> inprogress` 원자적 rename
- 결과 파일 생성 후 원본 work 파일은 `inprogress`에서 제거
- `to: codex`는 기본 `codex exec --json --ephemeral` 경로를 사용하고, `agent_message` 이벤트를 결과 본문으로 사용
- `to: gemini`는 Gemini CLI를 호출해 Codex용 후속 work 파일(`to: codex`)을 자동 생성

## 출력 파일
성공:
- `bridge/done/YYYYMMDDTHHMMSSZ_<thread>_<taskid>_from_<agent>.result.md`

실패:
- `bridge/error/YYYYMMDDTHHMMSSZ_<thread>_<taskid>_from_<agent>.error.md`

## 결과 메타
성공(`result`):
- `exit_code`, `elapsed_ms`, `retries`, `work_dir`, `status: done`

실패(`error`):
- `error_code`, `error_stage`, `retry_count`, `can_retry`, `status: error`

## Gemini -> Codex 자동 변환 옵션
`to: gemini` 작업에서 아래 선택 키를 사용할 수 있다.
- `codex_assign`: 후속 Codex 작업의 `assign` 오버라이드
- `codex_timeout_s`: 후속 Codex 작업 `timeout_s` 오버라이드
- `codex_max_retries`: 후속 Codex 작업 `max_retries` 오버라이드
