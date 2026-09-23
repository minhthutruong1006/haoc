@echo off
chcp 65001 >nul
cd /d E:\haoc-tistory-auto
start "" http://127.0.0.1:5043
node writer.js
