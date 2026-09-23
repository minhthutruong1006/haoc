@echo off
chcp 65001 >nul
cd /d E:\haoc-homepage-auto
echo [하오커뮤니케이션] haoc.co.kr/admin.html 관리자 로그인 창을 엽니다. 아이디/비밀번호로 로그인 후 창을 닫으세요.
echo (세션은 이 패키지 전용 chrome-profile 에 저장되며, 12시간 지나면 게시 때 다시 로그인 창이 뜹니다.)
node hp_login.js
pause
