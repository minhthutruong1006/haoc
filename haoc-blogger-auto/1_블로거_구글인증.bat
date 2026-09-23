@echo off
chcp 65001 >nul
cd /d E:\haoc-blogger-auto
echo [하오커뮤니케이션] Blogger API 인증 — haocommunication 블로그를 소유한 구글 계정으로 동의하세요. 성공하면 token.json 생성.
node blogauth.js
pause
