# P2 Ops Runbook

## 1. 목적
- 운영 안정화 기본 절차(헬스/API/백업/복구/배포)를 고정한다.

## 2. API 서버 실행
```bash
npm run start:api
```

기본 환경값:
- `API_HOST=127.0.0.1`
- `API_PORT=8787`
- `API_READ_ONLY=true`
- `RUNTIME_DB_PATH=data/runtime_db.json`

## 3. API 점검
```bash
curl -s http://127.0.0.1:8787/api/health | jq
curl -s "http://127.0.0.1:8787/api/repos/top?limit=20&windowHours=24" | jq
curl -s "http://127.0.0.1:8787/api/alerts?limit=50" | jq
curl -s http://127.0.0.1:8787/api/sources/health | jq
```

## 4. 백업/복구
백업:
```bash
npm run ops:backup
```

복구:
```bash
npm run ops:restore -- data/backups/runtime_db_YYYYMMDDTHHMMSSZ.json
```

## 5. 배포 스모크
```bash
npm run smoke:api
```

## 6. CD 동작
- `main` push 시 `.github/workflows/cd.yml`이 `scripts/deploy.sh`를 실행한다.
- 산출 로그는 `artifacts/cd.log`에 저장된다.

## 7. 장애 기본 대응
1. `npm run test:api`로 API 상태 재검증
2. `RUNTIME_DB_PATH` 존재 여부 확인
3. 필요시 백업본으로 `ops:restore` 수행
