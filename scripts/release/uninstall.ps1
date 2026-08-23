# Sephiria Tools 유동적 삭제 및 순정 복원 스크립트
#
# 특징:
#   1. 유저가 임의로 일부 파일을 먼저 지웠거나 순서가 꼬여도 오류 없이 유동적으로 잔여 파일 정리.
#   2. 다중 드라이브 Steam 라이브러리 자동 탐색 및 수동 입력 지원.
#   3. 실행 중인 프로세스(게임/오버레이) 안전 종료.
#   4. 읽기 전용 속성 강제 해제 후 깔끔한 삭제.
#   5. 타 BepInEx 모드 유무를 판별하여 [단독 모드면 순정화 / 타 모드 있으면 공존 유지].

param([string]$GameDir = "")

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Sephiria Tools (세피리아 꿀잼) 안전 삭제 및 원복" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. 게임 폴더 탐색 ─────────────────────────────────────────

function Find-GameDir {
    # 1. 스크립트가 게임 폴더 내부에 위치한 경우 (BepInEx\plugins\SephiriaTools)
    try {
        $parent3 = Split-Path (Split-Path (Split-Path $Here -Parent) -Parent) -Parent
        if ($parent3 -and (Test-Path (Join-Path $parent3 "Sephiria.exe"))) {
            return $parent3
        }
    } catch {}

    $steamRoots = @()
    foreach ($regPath in @("HKCU:\Software\Valve\Steam", "HKLM:\SOFTWARE\Valve\Steam", "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam")) {
        try {
            $reg = Get-ItemProperty -Path $regPath -Name SteamPath -ErrorAction SilentlyContinue
            if ($reg -and $reg.SteamPath) {
                $steamRoots += ($reg.SteamPath -replace '/', '\')
            }
        } catch {}
    }

    $steamRoots += "C:\Program Files (x86)\Steam"
    $steamRoots += "C:\Program Files\Steam"

    # 모든 드라이브의 SteamLibrary 검사
    try {
        $drives = Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root
        foreach ($d in $drives) {
            $steamRoots += (Join-Path $d "SteamLibrary")
            $steamRoots += (Join-Path $d "Steam")
            $steamRoots += (Join-Path $d "Games\Steam")
        }
    } catch {}

    $allLibraries = @()
    foreach ($root in ($steamRoots | Select-Object -Unique)) {
        if (-not (Test-Path $root)) { continue }
        $allLibraries += $root

        $vdf = Join-Path $root "steamapps\libraryfolders.vdf"
        if (Test-Path $vdf) {
            try {
                $matches = Select-String -Path $vdf -Pattern '"path"\s+"([^"]+)"' -AllMatches -ErrorAction SilentlyContinue
                foreach ($m in $matches.Matches) {
                    $libPath = ($m.Groups[1].Value -replace '\\\\', '\')
                    if (Test-Path $libPath) { $allLibraries += $libPath }
                }
            } catch {}
        }
    }

    foreach ($lib in ($allLibraries | Select-Object -Unique)) {
        $candidate = Join-Path $lib "steamapps\common\Sephiria"
        if (Test-Path (Join-Path $candidate "Sephiria.exe")) {
            return $candidate
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
    if (-not $GameDir -or -not (Test-Path (Join-Path $GameDir "Sephiria.exe"))) {
        Write-Host "[X] 유효한 Sephiria.exe 경로가 아닙니다. 작업을 중단합니다." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] 대상 게임 폴더: $GameDir" -ForegroundColor Green

# ── 2. 실행 중인 프로세스 검사 및 안전 종료 ───────────────────

$procs = Get-Process -Name "Sephiria", "Sephiria Tools Overlay", "electron", "UnityCrashHandler64" -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "[..] 안전한 파일 삭제를 위해 실행 중인 관련 프로세스를 종료합니다..." -ForegroundColor Yellow
    foreach ($p in $procs) {
        try {
            $p | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        } catch {}
    }
}

# ── 3. 유동적 파일 정리 (순서/누락 무관하게 안전 처리) ────────

$removedItems = @()

function Safe-Remove-Path($targetPath, $label) {
    if (Test-Path $targetPath) {
        try {
            # 읽기 전용 속성 해제
            if (Test-Path -PathType Container $targetPath) {
                Get-ChildItem $targetPath -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.IsReadOnly = $false }
            } else {
                (Get-Item $targetPath -Force -ErrorAction SilentlyContinue).IsReadOnly = $false
            }
            Remove-Item $targetPath -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "[OK] $label 제거 완료" -ForegroundColor Green
            return $true
        } catch {
            Write-Host "[!] $label 제거 중 경고: $_" -ForegroundColor Yellow
            return $false
        }
    }
    return $false
}

$pluginDir = Join-Path $GameDir "BepInEx\plugins\SephiriaTools"
$overlayDir = Join-Path $pluginDir "Overlay"
$configFile = Join-Path $GameDir "BepInEx\config\com.sephiria.tools.cfg"
$bepInExDir = Join-Path $GameDir "BepInEx"
$winhttpDll = Join-Path $GameDir "winhttp.dll"
$winhttpDisabled = Join-Path $GameDir "winhttp.dll.disabled"
$doorstopIni = Join-Path $GameDir "doorstop_config.ini"

# 3-1. SephiriaTools 플러그인 & 오버레이 폴더 제거
if (Safe-Remove-Path $pluginDir "SephiriaTools 플러그인 및 오버레이") {
    $removedItems += "플러그인 및 오버레이"
}

# 3-2. 설정 파일 제거
if (Safe-Remove-Path $configFile "SephiriaTools 설정 파일") {
    $removedItems += "설정 파일"
}

# 3-3. 타 플러그인 여부 확인
$pluginsBaseDir = Join-Path $GameDir "BepInEx\plugins"
$hasOtherPlugins = $false

if (Test-Path $pluginsBaseDir) {
    $otherItems = Get-ChildItem $pluginsBaseDir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "SephiriaTools" }
    if ($otherItems -and $otherItems.Count -gt 0) {
        $hasOtherPlugins = $true
    }
}

if ($hasOtherPlugins) {
    Write-Host ""
    Write-Host "[i] 다른 BepInEx 모드가 감지되어 BepInEx 코어는 유지하고," -ForegroundColor Cyan
    Write-Host "    Sephiria Tools 관련 파일만 안전하게 분리 제거했습니다." -ForegroundColor Cyan
} else {
    Write-Host "[..] 다른 BepInEx 모드가 없으므로 완전 순정(Vanilla) 복원을 진행합니다..." -ForegroundColor Yellow

    Safe-Remove-Path $winhttpDll "winhttp.dll (BepInEx 로더)" | Out-Null
    Safe-Remove-Path $winhttpDisabled "winhttp.dll.disabled" | Out-Null
    Safe-Remove-Path $doorstopIni "doorstop_config.ini" | Out-Null
    Safe-Remove-Path $bepInExDir "BepInEx 폴더 전체" | Out-Null
    $removedItems += "BepInEx 코어 및 순정 복원"
}

# ── 4. 결과 요약 ──────────────────────────────────────────────

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
if ($removedItems.Count -gt 0) {
    Write-Host "  ✨ Sephiria Tools 제거 및 정리가 완료되었습니다!" -ForegroundColor Green
    Write-Host "  (정리된 항목: $($removedItems -join ', '))" -ForegroundColor Gray
} else {
    Write-Host "  ℹ 게임 폴더에 Sephiria Tools 관련 파일이 이미 존재하지 않습니다." -ForegroundColor Yellow
    Write-Host "  (게임은 이미 깨끗한 순정 상태입니다)" -ForegroundColor Green
}
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
