@echo off
chcp 65001 >nul
title Sephiria Tools 설치
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
