#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-main}"
TITLE="${1:-}"
BODY_FILE="${2:-}"

if [[ -z "${TITLE}" ]]; then
  TITLE="chore: bridge update"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[error] gh 명령이 없습니다. GitHub CLI(official) 설치가 필요합니다."
  exit 2
fi

if gh --help 2>&1 | grep -qi "Main entry point for GitHubCli"; then
  echo "[error] 현재 gh는 GitHub CLI가 아니라 gitsome 입니다."
  echo "        gitsome 제거 후 GitHub CLI를 설치하세요."
  exit 2
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "[error] gh 인증이 없습니다. 'gh auth login' 실행이 필요합니다."
  exit 2
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ -z "${CURRENT_BRANCH}" ]]; then
  echo "[error] 현재 브랜치를 확인할 수 없습니다."
  exit 2
fi

if [[ "${CURRENT_BRANCH}" == "${BASE_BRANCH}" ]]; then
  echo "[error] base 브랜치(${BASE_BRANCH})에서 직접 PR을 만들 수 없습니다. 기능 브랜치로 전환하세요."
  exit 2
fi

git push -u origin "${CURRENT_BRANCH}"

if [[ -n "${BODY_FILE}" ]]; then
  if [[ ! -f "${BODY_FILE}" ]]; then
    echo "[error] body 파일을 찾을 수 없습니다: ${BODY_FILE}"
    exit 2
  fi
  gh pr create --base "${BASE_BRANCH}" --head "${CURRENT_BRANCH}" --title "${TITLE}" --body-file "${BODY_FILE}"
else
  gh pr create --base "${BASE_BRANCH}" --head "${CURRENT_BRANCH}" --title "${TITLE}" --body ""
fi

echo "[ok] PR 생성 요청 완료"

