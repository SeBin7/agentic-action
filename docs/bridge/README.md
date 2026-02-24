# File Bridge Router v1

## 목적
`Gemini 수동 입력 -> Router 자동 감지 -> Codex 자동 실행` 흐름을 안정적으로 운영한다.

## 활성 구성
- 큐/상태: `bridge/`
- 실행 코드: `tools/bridge/`
- 운영 문서: `docs/bridge/`

## 운영 원칙
- 단일 워커 순차 처리
- strict gate(`healthcheck.py`) 통과 전 work 소비 금지
- Codex 실행은 기본 `--json --ephemeral` 비대화형 스트림 경로 사용
- 결과 응답 언어 기본값은 한국어(`response_lang: ko`)
- 기본 `CODEX_HOME`은 project-local(`.runtime/codex_home`)이며 필요 시 `BRIDGE_CODEX_HOME_MODE=home` 전환 가능
- 실패는 `bridge/error/*.error.md`로 구조화 기록
