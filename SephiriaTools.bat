@echo off
title Sephiria Tools & Awakened Overlay Launcher
color 0b

echo ========================================================
echo   Sephiria Tools - 1-Click Game & Overlay Launcher
echo ========================================================
echo.
echo Launching Sephiria Game & Awakened PoE Trade Overlay...
echo.

:: Launch Game via Steam Protocol
start steam://rungameid/2436940

:: Launch Electron Overlay (starts transparent overlay & hotkeys)
cd /d "%~dp0overlay"
start "" npx electron .

echo.
echo Done! Game and Overlay are running!
echo HotKeys: [Ctrl+D] Quick Evaluator Card | [Shift+Tab] Full Overlay
timeout /t 3
