@echo off
chcp 65001 >nul
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%PATH%"
title HAOC - Claude 로그인
echo Claude Code가 실행됩니다. 프롬프트가 뜨면  /login  을 입력해 브라우저에서 로그인하세요.
echo (작성기 UI의 'Claude 계정 연동' 박스에서 해도 됩니다. 계정 저장소는 C:\claude-accounts — 하디·하스·하팩과 공용)
call claude
pause
