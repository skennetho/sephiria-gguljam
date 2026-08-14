# Sephiria Awakened Overlay - Run Script

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$OverlayDir = Join-Path $ProjectRoot "overlay"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Launching Sephiria Awakened Overlay" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "HotKeys Guide:" -ForegroundColor Yellow
Write-Host "  [Ctrl + D]        : Quick Artifact Evaluator Card Popup" -ForegroundColor White
Write-Host "  [Shift + Tab]     : Full Companion Dashboard Overlay" -ForegroundColor White
Write-Host "  [Ctrl + Shift + M]: Toggle Dungeon Minimap HUD" -ForegroundColor White
Write-Host "  [Esc]             : Close Active Overlay Card" -ForegroundColor White
Write-Host ""

Push-Location $OverlayDir
try {
    npx electron .
} finally {
    Pop-Location
}
