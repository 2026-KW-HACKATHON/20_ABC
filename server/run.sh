#!/usr/bin/env bash
# 기숙사 PC(맥·리눅스)에서 서버 실행: ./run.sh
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
. .venv/bin/activate
pip install -q -r requirements.txt
[ -f .env ] || { cp .env.example .env; echo ".env 를 만들었습니다. 관리자 비밀번호와 API 키를 채운 뒤 다시 실행하세요."; exit 1; }
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips='*'
