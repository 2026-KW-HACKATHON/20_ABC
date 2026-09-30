@echo off
rem 기숙사 PC(윈도우)에서 서버 실행: run.bat 더블클릭
chcp 65001 > nul
cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv || python -m venv .venv
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
if not exist .env (
  copy .env.example .env > nul
  echo .env 파일을 만들었습니다. 관리자 비밀번호와 API 키를 채운 뒤 다시 실행하세요.
  notepad .env
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=8000
uvicorn app.main:app --host 0.0.0.0 --port %PORT% --proxy-headers --forwarded-allow-ips=*
pause
