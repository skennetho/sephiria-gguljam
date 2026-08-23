# Sephiria Tools 설치 및 업데이트 스크립트
#
# 주요 기능:
#   1. Steam 라이브러리 (모든 드라이브 탐색)에서 Sephiria 설치 폴더를 찾는다.
#   2. 신규 설치 / 기존 버전 업데이트(Upgrade) 자동 감지.
#   3. 유저 데이터(즐겨찾기, 설정값, 프리셋 등)를 안전하게 백업 및 보존하며 업데이트.
#   4. BepInEx 및 SephiriaTools 플러그인, 오버레이, 최신 위키 데이터 설치/갱신.
#   5. 파일 잠금 및 보안 차단(Mark of the Web) 자동 해제.

param([string]$GameDir = "")

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Sephiria Tools (세피리아 꿀잼) 설치 & 업데이트" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. 게임 폴더 탐색 (전체 드라이브 스팀 라이브러리 검사) ──────

function Find-GameDir {
    $steamRoots = @()

    # 레지스트리 경로 수집
    foreach ($regPath in @("HKCU:\Software\Valve\Steam", "HKLM:\SOFTWARE\Valve\Steam", "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam")) {
        try {
            $reg = Get-ItemProperty -Path $regPath -Name SteamPath -ErrorAction SilentlyContinue
            if ($reg -and $reg.SteamPath) {
                $steamRoots += ($reg.SteamPath -replace '/', '\')
            }
        } catch {}
    }

    # 기본 경로
    $steamRoots += "C:\Program Files (x86)\Steam"
    $steamRoots += "C:\Program Files\Steam"

    # 모든 활성 드라이브의 SteamLibrary 폴더 탐색 (D:\SteamLibrary, E:\SteamLibrary 등)
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
    if (-not (Test-Path (Join-Path $GameDir "Sephiria.exe"))) {
        Write-Host "[X] 해당 경로에 Sephiria.exe 가 존재하지 않습니다. 설치를 중단합니다." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] 게임 폴더 확인: $GameDir" -ForegroundColor Green

# ── 2. 실행 중인 프로세스 검사 ─────────────────────────────────

$runningProcs = Get-Process -Name "Sephiria", "Sephiria Tools Overlay", "electron" -ErrorAction SilentlyContinue
if ($runningProcs) {
    Write-Host "[..] 원활한 파일 복사를 위해 실행 중인 관련 프로세스를 정리합니다..." -ForegroundColor Yellow
    foreach ($p in $runningProcs) {
        try {
            $p | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        } catch {}
    }
}

# ── 3. 기존 설치 상태 및 업데이트 모드 확인 ───────────────────

$bepInExDir = Join-Path $GameDir "BepInEx"
$pluginDir = Join-Path $GameDir "BepInEx\plugins\SephiriaTools"
$configDir = Join-Path $GameDir "BepInEx\config"
$configFile = Join-Path $configDir "com.sephiria.tools.cfg"

# 확장 가능한 사용자 데이터 디렉토리 (설정, 즐겨찾기, 프리셋 캐시 등)
$userDataDir = "$env:APPDATA\SephiriaTools"
$userBackupDir = Join-Path $userDataDir "backups"
try {
    if (-not (Test-Path $userBackupDir)) {
        New-Item -ItemType Directory -Force -Path $userBackupDir | Out-Null
    }
} catch {}

$isUpdate = (Test-Path $pluginDir)

if ($isUpdate) {
    Write-Host "[i] 기존 버전 설치가 감지되었습니다. -> [업데이트 모드] 진행" -ForegroundColor Cyan
    
    # 3-1. 기존 설정 및 사용자 데이터 백업 (유실 방지)
    $timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
    $backupDest = Join-Path $userBackupDir "backup_$timestamp"
    try {
        New-Item -ItemType Directory -Force -Path $backupDest | Out-Null
        if (Test-Path $configFile) {
            Copy-Item $configFile -Destination (Join-Path $backupDest "com.sephiria.tools.cfg") -Force -ErrorAction SilentlyContinue
        }
        $existingAssets = Join-Path $pluginDir "assets"
        if (Test-Path (Join-Path $existingAssets "database.json")) {
            Copy-Item (Join-Path $existingAssets "database.json") -Destination (Join-Path $backupDest "database.json") -Force -ErrorAction SilentlyContinue
        }
        Write-Host "[OK] 기존 사용자 설정 백업 완료 ($backupDest)" -ForegroundColor Green
    } catch {
        Write-Host "[!] 백업 중 알림 (계속 진행): $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "[i] 신규 설치를 진행합니다." -ForegroundColor Cyan
}

# ── 4. BepInEx 설치 / 확인 ────────────────────────────────────

if (Test-Path (Join-Path $GameDir "winhttp.dll")) {
    Write-Host "[OK] BepInEx 코어가 이미 설치되어 있습니다." -ForegroundColor Green
} elseif (Test-Path (Join-Path $GameDir "winhttp.dll.disabled")) {
    try {
        Rename-Item (Join-Path $GameDir "winhttp.dll.disabled") "winhttp.dll" -Force
        Write-Host "[OK] 비활성화되어 있던 BepInEx 코어를 재활성화했습니다." -ForegroundColor Green
    } catch {
        Copy-Item (Join-Path $Here "BepInEx\winhttp.dll") -Destination $GameDir -Force
    }
} else {
    Write-Host "[..] BepInEx 코어 파일 설치 중..." -ForegroundColor Yellow
    if (Test-Path (Join-Path $Here "BepInEx\BepInEx")) {
        Copy-Item (Join-Path $Here "BepInEx\BepInEx") -Destination $GameDir -Recurse -Force
    }
    if (Test-Path (Join-Path $Here "BepInEx\doorstop_config.ini")) {
        Copy-Item (Join-Path $Here "BepInEx\doorstop_config.ini") -Destination $GameDir -Force
    }
    if (Test-Path (Join-Path $Here "BepInEx\winhttp.dll")) {
        Copy-Item (Join-Path $Here "BepInEx\winhttp.dll") -Destination $GameDir -Force
    }
    Write-Host "[OK] BepInEx 코어 설치 완료" -ForegroundColor Green
}

# ── 5. 플러그인 DLL 복사 ──────────────────────────────────────

New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
if (Test-Path (Join-Path $Here "plugin\SephiriaTools.dll")) {
    Copy-Item (Join-Path $Here "plugin\SephiriaTools.dll") -Destination $pluginDir -Force
}

# 언인스톨러 스크립트도 플러그인 폴더 안에 항상 최신으로 복제
if (Test-Path (Join-Path $Here "Uninstall.bat")) {
    Copy-Item (Join-Path $Here "Uninstall.bat") -Destination $pluginDir -Force
    Copy-Item (Join-Path $Here "uninstall.ps1") -Destination $pluginDir -Force
}
Write-Host "[OK] SephiriaTools 플러그인 DLL 복사 완료" -ForegroundColor Green

# ── 6. Assets 시드 및 위키 데이터 갱신 ─────────────────────────

$assetsDir = Join-Path $pluginDir "assets"
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

$existingDb = Join-Path $assetsDir "database.json"
if (-not (Test-Path $existingDb)) {
    # 최초 설치: 전체 시드 복사
    if (Test-Path (Join-Path $Here "assets-seed")) {
        Copy-Item (Join-Path $Here "assets-seed\*") -Destination $assetsDir -Recurse -Force
        Write-Host "[OK] 인게임 아이템 DB 및 에셋 시드 완료" -ForegroundColor Green
    }
} else {
    # 업데이트: 게임이 생성한 database.json은 보존하고, 최신 위키 데이터 및 아이콘만 스마트 갱신
    if (Test-Path (Join-Path $Here "assets-seed\wiki")) {
        $destWiki = Join-Path $assetsDir "wiki"
        New-Item -ItemType Directory -Force -Path $destWiki | Out-Null
        Copy-Item (Join-Path $Here "assets-seed\wiki\*") -Destination $destWiki -Recurse -Force
        Write-Host "[OK] 기존 인게임 DB 보존 + 최신 위키 데이터 갱신 완료" -ForegroundColor Green
    }
}

# ── 7. 오버레이 배포 ──────────────────────────────────────────

$overlayDst = Join-Path $pluginDir "Overlay"
Write-Host "[..] 최신 오버레이 복사 중..." -ForegroundColor Yellow

if (Test-Path $overlayDst) {
    try {
        # 읽기 전용 해제 후 덮어쓰기
        Get-ChildItem $overlayDst -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.IsReadOnly = $false }
        Remove-Item $overlayDst -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
}

if (Test-Path (Join-Path $Here "Overlay")) {
    Copy-Item (Join-Path $Here "Overlay") -Destination $overlayDst -Recurse -Force
}

# SmartScreen 차단 방지 (Mark of the Web 제거)
try {
    Get-ChildItem $overlayDst -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
    Get-ChildItem $pluginDir -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
} catch {}

Write-Host "[OK] 오버레이 설치 완료: $overlayDst" -ForegroundColor Green

# ── 8. 완료 안내 ──────────────────────────────────────────────

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
if ($isUpdate) {
    Write-Host "  🎉 Sephiria Tools 업데이트가 성공적으로 완료되었습니다!" -ForegroundColor Green
    Write-Host "  (사용자 설정, 즐겨찾기 및 프리셋이 안전하게 보존되었습니다)" -ForegroundColor Green
} else {
    Write-Host "  🎉 Sephiria Tools 설치가 성공적으로 완료되었습니다!" -ForegroundColor Green
}
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🎮 사용 안내:" -ForegroundColor Yellow
Write-Host "  1. 평소처럼 Steam에서 세피리아 게임을 실행하시면 오버레이가 자동으로 뜹니다."
Write-Host "  2. 단축키: Ctrl+D (최적배치), Ctrl+B (위키빌드), F1 (팀원HUD), Ctrl+H (숨기기)"
Write-Host "  3. 압축을 푼 이 설치 폴더는 이제 자유롭게 삭제하셔도 무방합니다."
Write-Host ""
