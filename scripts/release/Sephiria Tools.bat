@echo off
chcp 65001 >nul
title Sephiria Tools

:: 대기 중인 플러그인 업데이트가 있으면 적용
if exist "%~dp0BepInEx\plugins\SephiriaTools\SephiriaTools.dll.pending" (
    move /y "%~dp0BepInEx\plugins\SephiriaTools\SephiriaTools.dll.pending" "%~dp0BepInEx\plugins\SephiriaTools\SephiriaTools.dll" >nul 2>&1
)

:: 게임이 안 떠 있으면 Steam 으로 실행
tasklist /FI "IMAGENAME eq Sephiria.exe" 2>nul | find /I "Sephiria.exe" >nul
if errorlevel 1 start "" steam://rungameid/2436940

:: 오버레이 실행 (게임이 종료되면 오버레이도 스스로 종료된다)
start "" "%~dp0Overlay\Sephiria Tools Overlay.exe"
