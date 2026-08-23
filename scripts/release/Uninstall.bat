@echo off
chcp 65001 >nul
title Sephiria Tools 안전 삭제 및 순정 복원
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
