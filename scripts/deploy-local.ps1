# 로컬 게임 폴더로 최신 빌드 즉시 복사 스크립트
$ErrorActionPreference = 'Stop'

$steamGameRoot = "C:\Program Files (x86)\Steam\steamapps\common\Sephiria"
$pluginDir = "$steamGameRoot\BepInEx\plugins\SephiriaTools"
$distDir = "C:\Users\user\git_default\SephiriaPlugin\dist\sephiria-gguljam-v0.3.0"
if (-not (Test-Path $distDir)) {
    $candidates = Get-ChildItem "C:\Users\user\git_default\SephiriaPlugin\dist" -Directory | Sort-Object LastWriteTime -Descending
    if ($candidates.Count -gt 0) { $distDir = $candidates[0].FullName }
}

# 프로세스 확인
$proc = Get-Process -Name 'Sephiria','Sephiria Tools Overlay' -ErrorAction SilentlyContinue
if ($proc) {
    Write-Warning "게임 또는 오버레이가 실행 중입니다. 파일을 복사하려면 게임을 종료해야 합니다."
    Write-Host "실행 중인 프로세스: $($proc.ProcessName -join ', ')"
    exit 1
}

Write-Host "최신 빌드 파일을 게임 폴더로 복사 중..." -ForegroundColor Cyan

# 1. DLL 복사
Copy-Item "$distDir\plugin\SephiriaTools.dll" -Destination "$pluginDir\SephiriaTools.dll" -Force

# 2. Overlay 폴더 복사
if (Test-Path "$pluginDir\Overlay") {
    Remove-Item "$pluginDir\Overlay" -Recurse -Force
}
Copy-Item "$distDir\Overlay" -Destination "$pluginDir\Overlay" -Recurse -Force

# 3. 루트 런처 및 유틸 복사
Copy-Item "$distDir\Sephiria Tools.bat" -Destination "$steamGameRoot\Sephiria Tools.bat" -Force

# 4. assets 시드 복사 (444개 DB 및 전체 아이콘)
if (Test-Path "$distDir\assets-seed") {
    if (-not (Test-Path "$pluginDir\assets")) {
        New-Item -ItemType Directory -Path "$pluginDir\assets" -Force | Out-Null
    }
    Copy-Item "$distDir\assets-seed\*" -Destination "$pluginDir\assets" -Recurse -Force
}

Write-Host "배포 완료! 이제 게임을 실행하시면 됩니다." -ForegroundColor Green
