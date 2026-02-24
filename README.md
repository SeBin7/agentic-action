# agentic-action

이 저장소는 **File Bridge Router v1** 운영을 기준으로 합니다.

활성 운영 경로:
- `bridge/`: 작업 큐(inbox/inprogress/done/error) 및 상태/로그
- `tools/bridge/`: healthcheck/router/worker 실행 코드
- `docs/bridge/`: 운영 문서 및 스펙

기본 결과 언어는 한국어(`response_lang: ko`)입니다.

레거시 실험 경로는 운영 범위에서 제외합니다.

## Quick Start

1. 환경 게이트 확인
```bash
python3 tools/bridge/healthcheck.py
```

2. 단일 처리 실행
```bash
python3 tools/bridge/router.py run-once
```

3. 데몬 실행
```bash
python3 tools/bridge/router.py daemon --interval 2
```

작업 파일 규격은 `docs/bridge/WORKFILE_SPEC.md`를 기준으로 합니다.
