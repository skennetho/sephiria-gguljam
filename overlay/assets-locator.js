// assets 폴더 위치 결정.
//
// 개발 중에는 저장소의 ../assets 를 쓰지만, 배포판에서는 그 폴더가 없다.
// 플러그인이 게임 폴더(BepInEx/plugins/SephiriaTools/assets)에 덤프하므로
// 게임 설치 경로를 찾아 그쪽을 우선 사용하고, 못 찾으면 동봉 스냅샷을 쓴다.
//
// 우선순위:
//   1. SEPHIRIA_ASSETS 환경변수 (문제 생겼을 때 수동 지정용)
//   2. 저장소 개발 배치      <repo>/assets            (git 작업본에서 실행할 때)
//   3. 게임 폴더 플러그인 덤프 <게임>/BepInEx/plugins/SephiriaTools/assets
//   4. 동봉 스냅샷           <앱>/assets-bundled
//
// 게임 설치 경로는 Steam 라이브러리 목록(libraryfolders.vdf)에서 찾는다.
// 레지스트리의 Steam 설치 경로 -> steamapps/libraryfolders.vdf -> 각 라이브러리의
// steamapps/common/Sephiria 순서로 훑는다.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GAME_DIR_NAME = 'Sephiria';
const PLUGIN_ASSETS_REL = path.join('BepInEx', 'plugins', 'SephiriaTools', 'assets');

/** Steam 설치 폴더를 레지스트리에서 읽는다. 실패하면 기본 경로들을 시도한다. */
function findSteamRoot(log) {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) {
      const p = m[1].trim().replace(/\//g, '\\');
      if (fs.existsSync(p)) return p;
    }
  } catch (err) {
    log && log.warn('assets', 'Steam 레지스트리 조회 실패', err.message);
  }

  for (const candidate of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** libraryfolders.vdf 에서 모든 스팀 라이브러리 경로를 뽑는다. */
function steamLibraries(steamRoot) {
  const libs = [steamRoot];
  try {
    const vdf = fs.readFileSync(
      path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    // "path"  "D:\\SteamLibrary" 꼴의 항목을 전부 수집
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = m[1].replace(/\\\\/g, '\\');
      if (!libs.includes(p) && fs.existsSync(p)) libs.push(p);
    }
  } catch { /* vdf 가 없으면 기본 라이브러리만 */ }
  return libs;
}

/** Sephiria 설치 폴더를 찾는다. 없으면 null. */
function findGameDir(log) {
  const steamRoot = findSteamRoot(log);
  if (!steamRoot) return null;

  for (const lib of steamLibraries(steamRoot)) {
    const gameDir = path.join(lib, 'steamapps', 'common', GAME_DIR_NAME);
    if (fs.existsSync(path.join(gameDir, 'Sephiria.exe'))) return gameDir;
  }
  return null;
}

/** 동봉 스냅샷 후보 경로들. 개발 시엔 앱 폴더, 패키징 시엔 exe 옆. */
function bundledCandidates(appRoot) {
  const list = [path.join(appRoot, 'assets-bundled')];
  try {
    list.push(path.join(path.dirname(process.execPath), 'assets-bundled'));
  } catch { /* execPath 가 없을 일은 없지만 방어 */ }
  return list;
}

function findBundled(appRoot) {
  for (const dir of bundledCandidates(appRoot)) {
    if (fs.existsSync(path.join(dir, 'database.json'))) return dir;
  }
  return null;
}

/**
 * assets 디렉터리를 결정한다.
 * @returns {{ dir: string, source: string, gameDir: string|null }}
 */
function locateAssets(appRoot, log) {
  // 1. 환경변수 강제 지정
  const forced = process.env.SEPHIRIA_ASSETS;
  if (forced && fs.existsSync(path.join(forced, 'database.json'))) {
    return { dir: forced, source: 'env', gameDir: null };
  }

  // 2. 저장소 개발 배치 (repo/overlay 에서 실행하면 repo/assets 가 있다)
  const devAssets = path.join(appRoot, '..', 'assets');
  if (fs.existsSync(path.join(devAssets, 'database.json'))) {
    return { dir: devAssets, source: 'dev', gameDir: null };
  }

  // 3. 게임 폴더의 플러그인 덤프
  const gameDir = findGameDir(log);
  if (gameDir) {
    const pluginAssets = path.join(gameDir, PLUGIN_ASSETS_REL);
    if (fs.existsSync(path.join(pluginAssets, 'database.json'))) {
      return { dir: pluginAssets, source: 'game', gameDir };
    }
    // 덤프가 아직 없어도 게임 폴더는 알아냈다 — 폴백을 쓰되 gameDir 는 알려준다
    const bundled = findBundled(appRoot);
    if (bundled) return { dir: bundled, source: 'bundled', gameDir };
    return { dir: pluginAssets, source: 'game-empty', gameDir };
  }

  // 4. 동봉 스냅샷
  const bundled = findBundled(appRoot);
  if (bundled) return { dir: bundled, source: 'bundled', gameDir: null };

  // 아무것도 없다 — 개발 경로를 돌려주되 소비자가 로드 실패를 처리한다
  return { dir: devAssets, source: 'missing', gameDir: null };
}

module.exports = { locateAssets, findGameDir };
