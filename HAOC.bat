@echo off
title HAOC
rem === HAOC one-button launcher (2026-09-14) ===
rem Starts the 3 writers + hub if not running, then opens ONE page with 3 tabs:
rem   Hub      http://127.0.0.1:5047  (E:\haoc-hub)
rem   Tistory  http://127.0.0.1:5043  (E:\haoc-tistory-auto)
rem   Blogspot http://127.0.0.1:5044  (E:\haoc-blogger-auto)
rem   Homepage http://127.0.0.1:5045  (E:\haoc-homepage-auto)
rem NOTE: writers must NOT start simultaneously -> each one is started
rem       only after the previous port answers (sequential, max 60s wait each).

call :ensure 5043 E:\haoc-tistory-auto writer.js
call :ensure 5044 E:\haoc-blogger-auto writer.js
call :ensure 5045 E:\haoc-homepage-auto writer.js
call :ensure 5047 E:\haoc-hub hub.js

start "" http://127.0.0.1:5047
exit

:ensure
netstat -ano | findstr ":%1 " | findstr LISTENING >nul
if errorlevel 1 (
  start "HAOC %1" /min cmd /c "cd /d %2 && node %3"
)
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%1)).Close();exit}catch{Start-Sleep 1}}"
exit /b
