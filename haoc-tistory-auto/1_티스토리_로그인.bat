@echo off
chcp 65001 >nul
cd /d E:\haoc-tistory-auto
echo [하오커뮤니케이션] 티스토리(카카오) 로그인 창을 엽니다. haocommunication 계정으로 로그인하세요.
echo (로그인이 자동 감지되면 세션이 auth.json 에 저장됩니다.)
node login.js
pause
