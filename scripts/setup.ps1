# Sephiria Tools - BepInEx 설치 & 플러그인 빌드 스크립트
# 사용법: PowerShell에서 .\scripts\setup.ps1 실행

param(
    [string]$GameDir = "C:\Program Files (x86)\Steam\steamapps\common\Sephiria"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$BepInExVersion = "5.4.23.2"
$BepInExUrl = "https://github.com/BepInEx/BepInEx/releases/download/v$BepInExVersion/BepInEx_win_x64_$BepInExVersion.zip"
$BepInExZip = Join-Path $ProjectRoot "libs\BepInEx.zip"
$BepInExLibDir = Join-Path $ProjectRoot "libs\BepInEx"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Sephiria Tools Setup Script" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Verify game directory ──────────────────────────────

if (-not (Test-Path "$GameDir\Sephiria.exe")) {
    Write-Host "[ERROR] Game not found at: $GameDir" -ForegroundColor Red
    Write-Host "Please specify the correct game directory:" -ForegroundColor Yellow
    Write-Host "  .\scripts\setup.ps1 -GameDir 'D:\path\to\Sephiria'" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Game found at: $GameDir" -ForegroundColor Green

# ── Step 2: Download BepInEx ───────────────────────────────────

$libsDir = Join-Path $ProjectRoot "libs"
if (-not (Test-Path $libsDir)) { New-Item -ItemType Directory -Path $libsDir | Out-Null }

if (-not (Test-Path $BepInExLibDir)) {
    Write-Host ""
    Write-Host "[1/4] Downloading BepInEx v$BepInExVersion..." -ForegroundColor Yellow

    if (-not (Test-Path $BepInExZip)) {
        Invoke-WebRequest -Uri $BepInExUrl -OutFile $BepInExZip -UseBasicParsing
        Write-Host "  Downloaded: $BepInExZip" -ForegroundColor Green
    }

    Write-Host "  Extracting..." -ForegroundColor Yellow
    Expand-Archive -Path $BepInExZip -DestinationPath $BepInExLibDir -Force
    Write-Host "  [OK] BepInEx extracted to libs/BepInEx" -ForegroundColor Green
} else {
    Write-Host "[1/4] BepInEx already downloaded." -ForegroundColor Green
}

# ── Step 3: Install BepInEx to game directory ──────────────────

$bepInExGameDir = Join-Path $GameDir "BepInEx"

if (-not (Test-Path $bepInExGameDir)) {
    Write-Host ""
    Write-Host "[2/4] Installing BepInEx to game directory..." -ForegroundColor Yellow

    # Copy BepInEx files to game directory
    Copy-Item -Path (Join-Path $BepInExLibDir "BepInEx") -Destination $GameDir -Recurse -Force
    Copy-Item -Path (Join-Path $BepInExLibDir "doorstop_config.ini") -Destination $GameDir -Force
    Copy-Item -Path (Join-Path $BepInExLibDir "winhttp.dll") -Destination $GameDir -Force
    
    Write-Host "  [OK] BepInEx installed to game directory" -ForegroundColor Green
    Write-Host ""
    Write-Host "  !! IMPORTANT: Run the game once now to generate BepInEx config !!" -ForegroundColor Magenta
    Write-Host "  (BepInEx will generate its config folder on first launch)" -ForegroundColor Magenta
    Write-Host ""

    # Create plugins directory
    $pluginsDir = Join-Path $bepInExGameDir "plugins"
    if (-not (Test-Path $pluginsDir)) {
        New-Item -ItemType Directory -Path $pluginsDir | Out-Null
    }
} else {
    Write-Host "[2/4] BepInEx already installed in game directory." -ForegroundColor Green
}

# ── Step 4: Build plugin ──────────────────────────────────────

Write-Host ""
Write-Host "[3/4] Building SephiriaTools plugin..." -ForegroundColor Yellow

$pluginDir = Join-Path $ProjectRoot "SephiriaPlugin"

# Build the plugin
Push-Location $pluginDir
try {
    dotnet build -c Release -p:GameDir="$GameDir" 2>&1 | ForEach-Object {
        if ($_ -match "error") { Write-Host "  $_" -ForegroundColor Red }
        elseif ($_ -match "warning") { Write-Host "  $_" -ForegroundColor Yellow }
        else { Write-Host "  $_" }
    }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Build failed!" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

Write-Host "  [OK] Plugin built successfully" -ForegroundColor Green

# ── Step 5: Deploy plugin ──────────────────────────────────────

Write-Host ""
Write-Host "[4/4] Deploying plugin to game..." -ForegroundColor Yellow

$outputDll = Join-Path $pluginDir "bin\Release\SephiriaTools.dll"
$targetDir = Join-Path $GameDir "BepInEx\plugins\SephiriaTools"

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir | Out-Null
}

Copy-Item -Path $outputDll -Destination $targetDir -Force
Write-Host "  [OK] Deployed to: $targetDir\SephiriaTools.dll" -ForegroundColor Green

# ── Done ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run the game (Sephiria)" -ForegroundColor White
Write-Host "  2. Open dashboard\index.html in your browser (or run .\scripts\run_overlay.ps1)" -ForegroundColor White
Write-Host "  3. The dashboard/overlay connects to ws://localhost:5827 automatically" -ForegroundColor White
Write-Host ""
Write-Host "Tip: to export icons straight into this repo, set AssetsDir in" -ForegroundColor DarkGray
Write-Host "     $GameDir\BepInEx\config\com.sephiria.tools.cfg to:" -ForegroundColor DarkGray
Write-Host "     $ProjectRoot\assets" -ForegroundColor DarkGray
Write-Host ""
