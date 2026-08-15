# Sephiria Tools 설치기
#
# 하는 일:
#   1. Steam 라이브러리에서 Sephiria 설치 폴더를 찾는다
#   2. BepInEx 가 없으면 동봉본을 설치한다 (있으면 건드리지 않는다)
#   3. 플러그인 DLL 을 BepInEx/plugins/SephiriaTools/ 에 복사한다
#   4. 초기 assets(아이템 DB·아이콘)를 시드한다 — 이후 게임이 알아서 갱신
#   5. 오버레이 앱을 게임 폴더 안(plugins/SephiriaTools/Overlay)에 복사한다
#      — 게임을 켜면 플러그인이 오버레이를 자동으로 띄운다
#
# 게임 파일은 수정하지 않는다. 제거하려면 게임 폴더에서
# winhttp.dll 과 BepInEx 폴더만 지우면 된다.

param([string]$GameDir = "")

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Sephiria Tools 설치" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. 게임 폴더 찾기 ─────────────────────────────────────────

function Find-GameDir {
    # 레지스트리에서 Steam 경로
    $steamRoots = @()
    try {
        $reg = Get-ItemProperty -Path "HKCU:\Software\Valve\Steam" -Name SteamPath -ErrorAction Stop
        $steamRoots += ($reg.SteamPath -replace '/', '\')
    } catch {}
    $steamRoots += "C:\Program Files (x86)\Steam"
    $steamRoots += "C:\Program Files\Steam"

    foreach ($root in $steamRoots | Select-Object -Unique) {
        if (-not (Test-Path $root)) { continue }

        # 모든 스팀 라이브러리 수집
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
        Write-Host "[X] 해당 경로에 Sephiria.exe 가 없습니다. 설치를 중단합니다." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] 게임 폴더: $GameDir" -ForegroundColor Green

# 게임 실행 중이면 파일이 잠겨 있을 수 있다
if (Get-Process -Name "Sephiria" -ErrorAction SilentlyContinue) {
    Write-Host "[!] 게임이 실행 중입니다. 종료 후 다시 실행해 주세요." -ForegroundColor Red
    exit 1
}

# ── 2. BepInEx ────────────────────────────────────────────────

if (Test-Path (Join-Path $GameDir "winhttp.dll")) {
    Write-Host "[OK] BepInEx 이미 설치됨 - 건너뜀" -ForegroundColor Green
} elseif (Test-Path (Join-Path $GameDir "winhttp.dll.disabled")) {
    # 비활성화돼 있으면 활성화만
    Rename-Item (Join-Path $GameDir "winhttp.dll.disabled") "winhttp.dll"
    Write-Host "[OK] 비활성화돼 있던 BepInEx 를 활성화했습니다" -ForegroundColor Green
} else {
    Write-Host "[..] BepInEx 설치 중..." -ForegroundColor Yellow
    Copy-Item (Join-Path $Here "BepInEx\BepInEx") -Destination $GameDir -Recurse -Force
    Copy-Item (Join-Path $Here "BepInEx\doorstop_config.ini") -Destination $GameDir -Force
    Copy-Item (Join-Path $Here "BepInEx\winhttp.dll") -Destination $GameDir -Force
    Write-Host "[OK] BepInEx 설치 완료" -ForegroundColor Green
}

# ── 3. 플러그인 ───────────────────────────────────────────────

$pluginDir = Join-Path $GameDir "BepInEx\plugins\SephiriaTools"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item (Join-Path $Here "plugin\SephiriaTools.dll") -Destination $pluginDir -Force
if (Test-Path (Join-Path $Here "Uninstall.bat")) {
    Copy-Item (Join-Path $Here "Uninstall.bat") -Destination $pluginDir -Force
    Copy-Item (Join-Path $Here "uninstall.ps1") -Destination $pluginDir -Force
}
Write-Host "[OK] 플러그인 설치: $pluginDir" -ForegroundColor Green

# ── 4. assets 시드 ────────────────────────────────────────────
# 아이템 DB 와 아이콘. 이미 있으면 위키 데이터만 갱신한다
# (게임이 덤프한 최신 database.json 을 옛 스냅샷으로 덮지 않기 위해).

$assetsDir = Join-Path $pluginDir "assets"
if (-not (Test-Path (Join-Path $assetsDir "database.json"))) {
    Copy-Item (Join-Path $Here "assets-seed") -Destination $assetsDir -Recurse -Force
    Write-Host "[OK] 초기 assets 시드 완료" -ForegroundColor Green
} else {
    Copy-Item (Join-Path $Here "assets-seed\wiki") -Destination $assetsDir -Recurse -Force
    Write-Host "[OK] assets 이미 존재 - 위키 데이터만 갱신" -ForegroundColor Green
}

# ── 5. 오버레이 ───────────────────────────────────────────────
# 게임 폴더 안에 넣는다. 플러그인이 자기 DLL 옆에서 exe 를 찾아
# 게임 시작 시 자동으로 띄우므로, 압축 푼 폴더는 지워도 된다.

$overlayDst = Join-Path $pluginDir "Overlay"
if (Get-Process -Name "Sephiria Tools Overlay" -ErrorAction SilentlyContinue) {
    Write-Host "[!] 오버레이가 실행 중입니다. 종료 후 다시 설치해 주세요." -ForegroundColor Red
    exit 1
}
Write-Host "[..] 오버레이 복사 중... (약 260MB, 잠시 걸립니다)" -ForegroundColor Yellow
if (Test-Path $overlayDst) { Remove-Item $overlayDst -Recurse -Force }
Copy-Item (Join-Path $Here "Overlay") -Destination $overlayDst -Recurse -Force

# 다운로드 표시(Mark of the Web) 제거 — 게임 도중 SmartScreen 이
# 조용히 실행을 막는 것을 방지한다. 설치기를 실행한 시점에 이미 동의한 것.
Get-ChildItem $overlayDst -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
Write-Host "[OK] 오버레이 설치: $overlayDst" -ForegroundColor Green

# ── 완료 ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  설치 완료!" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "사용법:" -ForegroundColor Yellow
Write-Host "  그냥 게임을 켜면 됩니다. 오버레이가 자동으로 함께 뜨고,"
Write-Host "  게임을 끄면 자동으로 닫힙니다."
Write-Host ""
Write-Host "  * 압축 푼 이 폴더는 이제 지워도 됩니다."
Write-Host "  * 자동 실행을 끄려면: 게임폴더\BepInEx\config\com.sephiria.tools.cfg"
Write-Host "    에서 [Overlay] AutoLaunch = false"
Write-Host ""
Write-Host "게임 내 단축키:" -ForegroundColor Yellow
Write-Host "  Ctrl+D  최적 배치 패널"
Write-Host "  Ctrl+B  위키 빌드 브라우저"
Write-Host "  Ctrl+H  하단 단축키 바 숨기기"
Write-Host "  Ctrl+Q  오버레이 종료"
Write-Host ""
Write-Host "* 게임 화면 설정을 '테두리 없는 창(Borderless)' 으로 해야" -ForegroundColor DarkYellow
Write-Host "  오버레이가 게임 위에 표시됩니다." -ForegroundColor DarkYellow
Write-Host ""
