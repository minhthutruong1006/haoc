@echo off
chcp 65001 >nul
cd /d E:\haoc-blogger-auto
start "" http://127.0.0.1:5044
node writer.js
