#!/usr/bin/env node
// 배포용 릴리스 zip 을 만든다.
//
//   node scripts/build-release.mjs
//
// 산출물: dist/SephiriaTools-v<버전>.zip
//
// zip 구성:
//   SephiriaTools-v<버전>/
//   ├── Install.bat            더블클릭 설치기 (install.ps1 래퍼)
//   ├── install.ps1            게임 폴더 탐색 + BepInEx/플러그인/시드 assets 설치
//   ├── Sephiria Tools.bat     게임 + 오버레이 동시 실행 런처
//   ├── README.txt             설치/사용 안내
//   ├── BepInEx/               동봉 BepInEx (LGPL — LICENSE 포함)
//   ├── plugin/SephiriaTools.dll
//   ├── assets-seed/           초기 assets (아이템 DB·아이콘·위키 데이터)
//   └── Overlay/               패키징된 Electron 앱
//       └── Sephiria Tools Overlay.exe
//
// 설계 메모:
// - assets 는 설치 시 게임 폴더(BepInEx/plugins/SephiriaTools/assets)로 복사한다.
//   플러그인 기본 설정이 'DLL 옆 assets' 에 덤프하므로, 이후 게임이 알아서 갱신한다.
//   오버레이의 assets-locator 가 같은 경로를 찾아 읽는다.
// - 오버레이 안에도 assets-bundled 스냅샷을 넣어 게임 폴더를 못 찾아도 뜨게 한다.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const pkg = JSON.parse(fs.readFileSync('overlay/package.json', 'utf8'));
const VERSION = pkg.version;
const NAME = `sephiria-gguljam-v${VERSION}`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, NAME);

const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: 'inherit', ...opts });

function step(msg) { console.log(`\n■ ${msg}`); }

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (!filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

// ── 0. 사전 점검 ────────────────────────────────────────────────

step('사전 점검');

if (!fs.existsSync('libs/BepInEx/winhttp.dll')) {
  console.log('libs/BepInEx 가 없어 자동으로 BepInEx v5.4.23.2 를 다운로드합니다...');
  fs.mkdirSync('libs/BepInEx', { recursive: true });
  run(
    'powershell -NoProfile -Command "Invoke-WebRequest -Uri https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_win_x64_5.4.23.2.zip -OutFile \'libs/BepInEx.zip\' -UseBasicParsing; Expand-Archive -Path \'libs/BepInEx.zip\' -DestinationPath \'libs/BepInEx\' -Force; Remove-Item \'libs/BepInEx.zip\'"'
  );
}
if (!fs.existsSync('assets/database.json')) {
  console.error('assets/database.json 이 없습니다. 게임을 한 번 실행해 덤프를 만들어야 합니다.');
  process.exit(1);
}

// ── 1. 테스트 ───────────────────────────────────────────────────

step('옵티마이저 테스트');
run('node overlay/optimizer.test.js');

// ── 2. 플러그인 빌드 ────────────────────────────────────────────

step('플러그인 빌드');
const prebuiltDll = path.join(ROOT, 'prebuilt', 'SephiriaTools.dll');
const builtDll = path.join(ROOT, 'SephiriaPlugin', 'bin', 'Release', 'SephiriaTools.dll');

try {
  run('dotnet build -c Release', { cwd: path.join(ROOT, 'SephiriaPlugin') });
  if (fs.existsSync(builtDll)) {
    fs.mkdirSync(path.join(ROOT, 'prebuilt'), { recursive: true });
    fs.copyFileSync(builtDll, prebuiltDll);
  }
} catch (err) {
  if (fs.existsSync(prebuiltDll)) {
    console.log('게임 어셈블리가 없어 prebuilt/SephiriaTools.dll 을 사용합니다.');
  } else {
    throw err;
  }
}

// ── 3. 스테이징 초기화 ──────────────────────────────────────────

step(`스테이징: ${STAGE}`);
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// ── 4. 오버레이 패키징 ──────────────────────────────────────────

step('오버레이 패키징 (Electron)');

// 스냅샷은 asar 밖(exe 옆)에 둔다. asar 내부는 file:// 이미지 접근이 안 된다.
run(
  'npx @electron/packager . "Sephiria Tools Overlay" ' +
  '--platform=win32 --arch=x64 ' +
  `--out=${JSON.stringify(path.join(DIST, 'packager-out'))} ` +
  '--overwrite --asar ' +
  // 소스에서 제외할 것들 (테스트·로그·개발 파일·스냅샷)
  '--ignore="optimizer\\.test\\.js$" --ignore="overlay\\.log" ' +
  '--ignore="assets-bundled" --ignore="node_modules"',
  { cwd: path.join(ROOT, 'overlay') },
);

const packagerOut = path.join(DIST, 'packager-out', 'Sephiria Tools Overlay-win32-x64');
if (!fs.existsSync(path.join(packagerOut, 'Sephiria Tools Overlay.exe'))) {
  console.error('패키징 결과를 찾지 못했습니다: ' + packagerOut);
  process.exit(1);
}
copyDir(packagerOut, path.join(STAGE, 'Overlay'));

// 동봉 스냅샷: exe 옆에 둔다. assets-locator 가 이 경로를 시도한다.
copyDir(path.join(ROOT, 'assets'), path.join(STAGE, 'Overlay', 'assets-bundled'),
  s => !s.endsWith('.bak'));

// ── 5. 플러그인 + BepInEx + 시드 assets ─────────────────────────

step('플러그인 / BepInEx / assets 시드 복사');

fs.mkdirSync(path.join(STAGE, 'plugin'), { recursive: true });
const targetPluginDll = fs.existsSync(builtDll) ? builtDll : prebuiltDll;
fs.copyFileSync(targetPluginDll, path.join(STAGE, 'plugin', 'SephiriaTools.dll'));

copyDir('libs/BepInEx', path.join(STAGE, 'BepInEx'));

copyDir('assets', path.join(STAGE, 'assets-seed'), s => !s.endsWith('.bak'));

// ── 6. 설치기 / 런처 / 문서 ─────────────────────────────────────

step('설치기·런처·문서 복사');

for (const f of ['install.ps1', 'Install.bat', 'uninstall.ps1', 'Uninstall.bat', 'Sephiria Tools.bat', 'README.txt']) {
  const src = path.join(ROOT, 'scripts', 'release', f);
  if (!fs.existsSync(src)) {
    console.error(`scripts/release/${f} 가 없습니다.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(STAGE, f));
}

// BepInEx 라이선스 고지 (LGPL 재배포 요건)
fs.writeFileSync(path.join(STAGE, 'BepInEx', 'LICENSE-NOTICE.txt'),
  'This package redistributes BepInEx (https://github.com/BepInEx/BepInEx),\n' +
  'licensed under LGPL-2.1. Source: https://github.com/BepInEx/BepInEx\n', 'utf8');

// ── 7. zip ──────────────────────────────────────────────────────

step('zip 생성');
const zipPath = path.join(DIST, `${NAME}.zip`);
try { fs.rmSync(zipPath, { force: true }); } catch {}
run(`powershell -NoProfile -Command "Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force"`);

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`\n완료: ${zipPath} (${mb}MB)`);
