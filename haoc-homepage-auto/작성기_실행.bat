@echo off
chcp 65001 >nul
cd /d E:\haoc-homepage-auto
start "" http://127.0.0.1:5045
node writer.js
