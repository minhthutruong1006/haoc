@echo off
chcp 65001 >nul
cd /d E:\haoc-tistory-auto
echo [하오커뮤니케이션] 3개 블로그의 카테고리 목록을 읽어 categories.json 에 저장합니다(로그인 후 실행).
node fetch-categories.js
pause
