@echo off
chcp 65001 >nul
title Sephiria Tools 삭제/원복
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
