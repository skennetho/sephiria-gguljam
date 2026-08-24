// Sephiria 인앱 업데이트 엔진
//
// GitHub Releases API 를 통해 최신 버전을 확인하고,
// 패치(오버레이만) / 마이너·메이저(DLL 포함) 업데이트를 처리한다.
//
// 패치 업데이트:  오버레이 resources/app.asar 교체 → app.relaunch()
// 마이너/메이저:  스테이징 → 게임 종료 시 install.ps1 자동 실행

'use strict';

const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');
const { log } = require('./util');

const GITHUB_REPO = 'skennetho/sephiria-gguljam';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const pkg = require('../package.json');
const CURRENT_VERSION = pkg.version;

// %APPDATA%\SephiriaTools\updates\
const UPDATES_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'SephiriaTools', 'updates'
);
const STAGED_FLAG = path.join(UPDATES_DIR, 'staged', 'pending.json');

// ── semver 비교 ────────────────────────────────────────

/**
 * 두 버전을 비교해 업데이트 유형을 반환한다.
 * @param {string} current  현재 버전 (예: '0.2.0')
 * @param {string} latest   최신 버전 (예: '0.2.1' 또는 '0.3.0')
 * @returns {'none'|'patch'|'major'}
 *   - 'none'  : 최신 버전이 현재와 같거나 낮음
 *   - 'patch' : 패치만 변경 (오버레이만 교체, 게임 유지)
 *   - 'major' : 마이너/메이저 변경 (DLL 포함, 재시작 필요)
 */
function getUpdateType(current, latest) {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);

  // 최신 버전이 현재보다 높은지 확인
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) break;
    if ((l[i] || 0) < (c[i] || 0)) return 'none';
    if (i === 2) return 'none'; // 동일 버전
  }

  // 메이저 또는 마이너가 변경되면 DLL 교체 필요
  if (l[0] !== c[0] || l[1] !== c[1]) return 'major';
  return 'patch';
}

// ── GitHub API 조회 ────────────────────────────────────

/**
 * GitHub Releases API 에서 최신 릴리스 정보를 가져온다.
 * @returns {Promise<{available: boolean, version: string, type: string, downloadUrl: string, changelog: string} | null>}
 */
async function checkForUpdate() {
  log.info('updater', '업데이트 확인 시작', { current: CURRENT_VERSION });
  try {
    const result = await ipcRenderer.invoke('check-update', {
      apiUrl: GITHUB_API,
      currentVersion: CURRENT_VERSION,
    });
    if (!result) return null;

    const type = getUpdateType(CURRENT_VERSION, result.version);
    log.info('updater', '업데이트 확인 결과', { latest: result.version, type });

    return {
      available: type !== 'none',
      version: result.version,
      type,
      downloadUrl: result.downloadUrl,
      changelog: result.changelog || '',
    };
  } catch (err) {
    log.error('updater', '업데이트 확인 실패', err.message);
    return null;
  }
}

// ── 다운로드 & 적용 ────────────────────────────────────

/**
 * 업데이트 zip 을 다운로드하고 적용/스테이징한다.
 * @param {string} downloadUrl  GitHub release asset URL
 * @param {string} type         'patch' | 'major'
 * @param {string} version      대상 버전
 * @param {function} onProgress 진행률 콜백 (0~100)
 * @returns {Promise<boolean>}  성공 여부
 */
async function downloadAndApply(downloadUrl, type, version, onProgress) {
  log.info('updater', '다운로드 시작', { url: downloadUrl, type, version });
  try {
    const result = await ipcRenderer.invoke('download-and-apply-update', {
      downloadUrl,
      type,
      version,
      updatesDir: UPDATES_DIR,
    });

    if (!result || !result.ok) {
      log.error('updater', '다운로드/적용 실패', result && result.error);
      return false;
    }

    if (type === 'patch') {
      log.info('updater', '패치 업데이트 적용 완료 — 오버레이 재시작');
      // main.js 에서 app.relaunch() + app.exit(0) 처리
    } else {
      log.info('updater', '마이너/메이저 업데이트 스테이징 완료', { version });
      // staged/pending.json 에 기록됨 — 게임 종료 시 main.js 에서 적용
    }

    return true;
  } catch (err) {
    log.error('updater', '다운로드 중 예외', err.message);
    return false;
  }
}

// ── 스테이징 상태 확인 ─────────────────────────────────

/**
 * 대기 중인 스테이징 업데이트가 있는지 확인한다.
 * @returns {{ version: string, stagedDir: string } | null}
 */
function getStagedUpdate() {
  try {
    if (fs.existsSync(STAGED_FLAG)) {
      const info = JSON.parse(fs.readFileSync(STAGED_FLAG, 'utf8'));
      if (info && info.version && info.stagedDir && fs.existsSync(info.stagedDir)) {
        return info;
      }
    }
  } catch {}
  return null;
}

module.exports = {
  CURRENT_VERSION,
  GITHUB_REPO,
  getUpdateType,
  checkForUpdate,
  downloadAndApply,
  getStagedUpdate,
  UPDATES_DIR,
};
