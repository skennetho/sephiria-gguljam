// 설정 패널 — 정보, 업데이트, 환경설정
//
// 기존 패널(optimizer, builds, team)과 동일한 init() 패턴을 따른다.
// updater.js 모듈을 통해 GitHub 릴리스 기반 인앱 업데이트를 수행한다.

'use strict';

const { log, guard } = require('./util');
const i18n = require('./i18n');
const updater = require('./updater');

let updateInfo = null;    // 마지막으로 조회한 업데이트 정보
let isChecking = false;
let isDownloading = false;

// ── DOM 참조 ───────────────────────────────────────────

function $(id) { return document.getElementById(id); }

// ── UI 갱신 ────────────────────────────────────────────

function refreshUI() {
  // 버전 표시
  const verEl = $('settings-version-value');
  if (verEl) verEl.textContent = `v${updater.CURRENT_VERSION}`;

  // GitHub 링크
  const ghEl = $('settings-github-link');
  if (ghEl) ghEl.href = `https://github.com/${updater.GITHUB_REPO}`;

  // 섹션 타이틀
  const infoTitle = $('settings-info-title');
  if (infoTitle) infoTitle.textContent = i18n.t('settings.info');
  const updateTitle = $('settings-update-title');
  if (updateTitle) updateTitle.textContent = i18n.t('settings.update');
  const prefTitle = $('settings-pref-title');
  if (prefTitle) prefTitle.textContent = i18n.t('settings.preferences');

  // 라벨
  const verLabel = $('settings-version-label');
  if (verLabel) verLabel.textContent = i18n.t('settings.version');
  const ghLabel = $('settings-github-label');
  if (ghLabel) ghLabel.textContent = i18n.t('settings.github');
  const langLabel = $('settings-lang-label');
  if (langLabel) langLabel.textContent = i18n.t('settings.language');

  // 언어 셀렉트
  const langSel = $('settings-lang-select');
  if (langSel) langSel.value = i18n.getLanguage();

  // 업데이트 버튼
  const checkBtn = $('btn-check-update');
  if (checkBtn) {
    if (isChecking) {
      checkBtn.textContent = i18n.t('settings.checking');
      checkBtn.disabled = true;
    } else if (isDownloading) {
      checkBtn.textContent = i18n.t('settings.applying');
      checkBtn.disabled = true;
    } else {
      checkBtn.textContent = i18n.t('settings.checkUpdate');
      checkBtn.disabled = false;
    }
  }

  // 업데이트 상태
  refreshUpdateStatus();
}

function refreshUpdateStatus() {
  const statusEl = $('update-status');
  if (!statusEl) return;

  // 1. 스테이징된 업데이트가 있는지 확인
  const staged = updater.getStagedUpdate();
  if (staged) {
    statusEl.className = 'update-status staged';
    statusEl.textContent = i18n.t('settings.staged', { version: staged.version });
    hideApplyButton();
    return;
  }

  // 2. 조회 결과에 따라 표시
  if (!updateInfo) {
    statusEl.className = 'update-status';
    statusEl.textContent = '';
    hideApplyButton();
    return;
  }

  if (updateInfo.error) {
    statusEl.className = 'update-status error';
    statusEl.textContent = i18n.t('settings.checkFail');
    hideApplyButton();
    return;
  }

  if (!updateInfo.available) {
    statusEl.className = 'update-status up-to-date';
    statusEl.textContent = i18n.t('settings.upToDate', { version: updater.CURRENT_VERSION });
    hideApplyButton();
    return;
  }

  // 업데이트 사용 가능
  statusEl.className = 'update-status available';
  const lines = [i18n.t('settings.available', { version: updateInfo.version })];
  if (updateInfo.type === 'patch') {
    lines.push(i18n.t('settings.patchReady'));
  } else {
    lines.push(i18n.t('settings.majorReady'));
  }
  statusEl.innerHTML = lines.join('<br>');

  // 적용 버튼 표시
  showApplyButton();
}

function showApplyButton() {
  const btn = $('btn-apply-update');
  if (btn) {
    btn.classList.remove('hidden');
    btn.textContent = i18n.t('settings.applyNow');
    btn.disabled = isDownloading;
  }
}

function hideApplyButton() {
  const btn = $('btn-apply-update');
  if (btn) btn.classList.add('hidden');
}

function showProgress(percent) {
  const bar = $('update-progress');
  const fill = $('update-progress-fill');
  if (bar) bar.classList.remove('hidden');
  if (fill) fill.style.width = `${percent}%`;

  const statusEl = $('update-status');
  if (statusEl) {
    statusEl.className = 'update-status downloading';
    statusEl.textContent = i18n.t('settings.downloading', { percent: Math.round(percent) });
  }
}

function hideProgress() {
  const bar = $('update-progress');
  if (bar) bar.classList.add('hidden');
}

// ── 이벤트 핸들러 ──────────────────────────────────────

async function onCheckUpdate() {
  if (isChecking || isDownloading) return;

  isChecking = true;
  updateInfo = null;
  refreshUI();

  const result = await updater.checkForUpdate();
  isChecking = false;

  if (result) {
    updateInfo = result;
  } else {
    updateInfo = { error: true };
  }

  refreshUI();
}

async function onApplyUpdate() {
  if (!updateInfo || !updateInfo.available || isDownloading) return;

  isDownloading = true;
  refreshUI();
  showProgress(0);

  const ok = await updater.downloadAndApply(
    updateInfo.downloadUrl,
    updateInfo.type,
    updateInfo.version,
    (percent) => showProgress(percent)
  );

  isDownloading = false;
  hideProgress();

  if (ok) {
    if (updateInfo.type === 'patch') {
      // main.js 가 app.relaunch() 처리 — 여기서는 UI만 갱신
      const statusEl = $('update-status');
      if (statusEl) {
        statusEl.className = 'update-status up-to-date';
        statusEl.textContent = i18n.t('settings.applying');
      }
    } else {
      // 스테이징 완료 — 게임 종료 시 적용
      updateInfo = null;
      refreshUI();
    }
  } else {
    const statusEl = $('update-status');
    if (statusEl) {
      statusEl.className = 'update-status error';
      statusEl.textContent = i18n.t('settings.downloadFail');
    }
  }
}

function onLanguageChange(e) {
  const lang = e.target.value;
  i18n.setLanguage(lang);
}

// ── 초기화 ─────────────────────────────────────────────

function init() {
  log.info('settings', '설정 패널 초기화');

  // 업데이트 확인 버튼
  const checkBtn = $('btn-check-update');
  if (checkBtn) {
    checkBtn.addEventListener('click', guard('settings-check', onCheckUpdate));
  }

  // 업데이트 적용 버튼
  const applyBtn = $('btn-apply-update');
  if (applyBtn) {
    applyBtn.addEventListener('click', guard('settings-apply', onApplyUpdate));
  }

  // 언어 변경 셀렉트
  const langSel = $('settings-lang-select');
  if (langSel) {
    langSel.value = i18n.getLanguage();
    langSel.addEventListener('change', guard('settings-lang', onLanguageChange));
  }

  // i18n 변경 시 UI 갱신
  i18n.onLanguageChange(() => refreshUI());

  // 초기 UI 그리기
  refreshUI();

  // 시작 시 자동으로 업데이트 확인 (5초 후, 비동기)
  setTimeout(() => {
    onCheckUpdate().catch(() => {});
  }, 5000);
}

module.exports = { init };
