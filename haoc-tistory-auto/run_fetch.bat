@echo off
chcp 65001 >nul
cd /d E:\haoc-tistory-auto
node fetch-questions.js
pause
