# Sephiria Tools 삭제/원복 스크립트
#
# 하는 일:
#   1. Steam 라이브러리에서 Sephiria 설치 폴더를 찾는다
#   2. 실행 중인 게임 또는 오버레이가 있으면 확인 후 종료 안내
#   3. SephiriaTools 플러그인, 오버레이, 설정 파일 삭제
#   4. 다른 BepInEx 모드가 없으면 BepInEx 전체(winhttp.dll, BepInEx 폴더)를 삭제하여 순정 복원

param([string]$GameDir = "")

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Sephiria Tools 삭제 및 순정 복원" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. 게임 폴더 찾기 ─────────────────────────────────────────

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-GameDir {
    # 스크립트 자체가 게임 폴더 내부에 위치한 경우 (BepInEx\plugins\SephiriaTools)
    try {
        $parent3 = Split-Path (Split-Path (Split-Path $Here -Parent) -Parent) -Parent
        if ($parent3 -and (Test-Path (Join-Path $parent3 "Sephiria.exe"))) {
            return $parent3
        }
    } catch {}

    $steamRoots = @()
    try {
        $reg = Get-ItemProperty -Path "HKCU:\Software\Valve\Steam" -Name SteamPath -ErrorAction Stop
        $steamRoots += ($reg.SteamPath -replace '/', '\')
    } catch {}
    $steamRoots += "C:\Program Files (x86)\Steam"
    $steamRoots += "C:\Program Files\Steam"

    foreach ($root in $steamRoots | Select-Object -Unique) {
        if (-not (Test-Path $root)) { continue }

        $libs = @($root)
        $vdf = Join-Path $root "steamapps\libraryfolders.vdf"
        if (Test-Path $vdf) {
            foreach ($m in (Select-String -Path $vdf -Pattern '"path"\s+"([^"]+)"' -AllMatches).Matches) {
                $libs += ($m.Groups[1].Value -replace '\\\\', '\')
            }
        }

        foreach ($lib in $libs | Select-Object -Unique) {
            $candidate = Join-Path $lib "steamapps\common\Sephiria"
            if (Test-Path (Join-Path $candidate "Sephiria.exe")) { return $candidate }
        }
    }
    return $null
}

if (-not $GameDir) { $GameDir = Find-GameDir }

if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir "Sephiria.exe"))) {
    Write-Host "[!] Sephiria 설치 폴더를 자동으로 찾지 못했습니다." -ForegroundColor Yellow
    Write-Host "    게임 폴더 경로를 직접 입력해 주세요."
    Write-Host "    (예: D:\SteamLibrary\steamapps\common\Sephiria)"
    $GameDir = Read-Host "게임 폴더"
    if (-not (Test-Path (Join-Path $GameDir "Sephiria.exe"))) {
        Write-Host "[X] 해당 경로에 Sephiria.exe 가 없습니다. 작업을 중단합니다." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] 게임 폴더: $GameDir" -ForegroundColor Green

# ── 2. 실행 중인 프로세스 확인 ─────────────────────────────────

if (Get-Process -Name "Sephiria" -ErrorAction SilentlyContinue) {
    Write-Host "[!] Sephiria 게임이 실행 중입니다. 게임을 종료한 뒤 다시 실행해 주세요." -ForegroundColor Red
    exit 1
}

$overlayProc = Get-Process -Name "Sephiria Tools Overlay" -ErrorAction SilentlyContinue
if ($overlayProc) {
    Write-Host "[..] 실행 중인 Sephiria Tools Overlay 종료 중..." -ForegroundColor Yellow
    $overlayProc | Stop-Process -Force -ErrorAction SilentlyContinue
}

# ── 3. 파일 삭제 및 정리 ─────────────────────────────────────

$bepInExDir = Join-Path $GameDir "BepInEx"
$pluginDir = Join-Path $GameDir "BepInEx\plugins\SephiriaTools"
$configFile = Join-Path $GameDir "BepInEx\config\com.sephiria.tools.cfg"
$winhttpDll = Join-Path $GameDir "winhttp.dll"
$doorstopIni = Join-Path $GameDir "doorstop_config.ini"

$removedAny = $false

# 3-1. SephiriaTools 플러그인 & 오버레이 폴더 삭제
if (Test-Path $pluginDir) {
    Write-Host "[..] SephiriaTools 플러그인 및 오버레이 삭제 중..." -ForegroundColor Yellow
    Remove-Item $pluginDir -Recurse -Force
    Write-Host "[OK] SephiriaTools 플러그인 삭제 완료" -ForegroundColor Green
    $removedAny = $true
}

# 3-2. 설정 파일 삭제
if (Test-Path $configFile) {
    Remove-Item $configFile -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] SephiriaTools 설정 파일 삭제 완료" -ForegroundColor Green
    $removedAny = $true
}

# 3-3. 다른 플러그인 존재 여부 확인
$pluginsBaseDir = Join-Path $GameDir "BepInEx\plugins"
$hasOtherPlugins = $false

if (Test-Path $pluginsBaseDir) {
    $otherItems = Get-ChildItem $pluginsBaseDir -Force | Where-Object { $_.Name -ne "SephiriaTools" }
    if ($otherItems.Count -gt 0) {
        $hasOtherPlugins = $true
    }
}

if ($hasOtherPlugins) {
    Write-Host ""
    Write-Host "[i] 다른 BepInEx 플러그인이 감지되어 BepInEx 본체는 유지하고" -ForegroundColor Cyan
    Write-Host "    Sephiria Tools 관련 파일만 안전하게 제거했습니다." -ForegroundColor Cyan
} else {
    # 다른 모드가 없으면 BepInEx 전체 삭제하여 순정화
    if (Test-Path $winhttpDll) {
        Remove-Item $winhttpDll -Force -ErrorAction SilentlyContinue
        $removedAny = $true
    }
    if (Test-Path (Join-Path $GameDir "winhttp.dll.disabled")) {
        Remove-Item (Join-Path $GameDir "winhttp.dll.disabled") -Force -ErrorAction SilentlyContinue
        $removedAny = $true
    }
    if (Test-Path $doorstopIni) {
        Remove-Item $doorstopIni -Force -ErrorAction SilentlyContinue
        $removedAny = $true
    }
    if (Test-Path $bepInExDir) {
        Remove-Item $bepInExDir -Recurse -Force -ErrorAction SilentlyContinue
        $removedAny = $true
    }
    Write-Host "[OK] BepInEx 전체 삭제 및 게임 순정 복원 완료" -ForegroundColor Green
}

# ── 4. 완료 안내 ──────────────────────────────────────────────

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
if ($removedAny) {
    Write-Host "  Sephiria Tools 가 성공적으로 삭제되었습니다." -ForegroundColor Green
} else {
    Write-Host "  설치된 Sephiria Tools 파일을 찾지 못했습니다." -ForegroundColor Yellow
}
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
