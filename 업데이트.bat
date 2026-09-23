@echo off
cd /d E:\haoc
echo [HAOC] git pull ... (writers will restart - make sure no job is running)
pause
git pull --ff-only
if errorlevel 1 (echo git pull FAILED & pause & exit /b 1)
powershell -NoProfile -Command "foreach($c in Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { 5043,5044,5045,5047 -contains $_.LocalPort }){ Stop-Process -Id $c.OwningProcess -Force }"
timeout /t 2 >nul
call E:\haoc\HAOC.bat
