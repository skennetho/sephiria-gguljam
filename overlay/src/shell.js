// 오버레이 껍데기: 패널 토글, 전역 단축키 IPC, 마우스 통과, 패널 드래그.

'use strict';

const { ipcRenderer } = require('electron');
const { log, guard } = require('./util');

const PANELS = {
  optimizer: 'panel-optimizer',
  builds: 'panel-builds',
  team: 'panel-team',
};

// 열린 패널 수. 0이면 마우스 통과 판정을 통째로 건너뛸 수 있다.
let openPanelCount = 0;

// 패널을 드래그하는 중에는 마우스 통과를 절대 켜면 안 된다.
// 켜는 순간 mouseup 을 못 받아 패널이 커서에 붙어버린다.
let dragging = false;

function refreshOpenPanelCount() {
  const prev = openPanelCount;
  openPanelCount = Object.values(PANELS)
    .filter(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    }).length;

  // 열림/닫힘이 뒤바뀔 때만 알린다. main 이 이 신호로 창을 띄우고 숨긴다
  // (열린 패널이 없으면 창을 숨겨야 게임이 독립 플립 경로를 유지한다).
  if ((prev === 0) !== (openPanelCount === 0)) {
    ipcRenderer.send('panels-open', openPanelCount > 0);
  }
}

function togglePanel(name) {
  const el = document.getElementById(PANELS[name]);
  if (!el) { log.error('panel', '패널 없음', name); return; }
  el.classList.toggle('hidden');
  refreshOpenPanelCount();
  log.info('panel', el.classList.contains('hidden') ? `${name} 닫음` : `${name} 열음`);
}

/**
 * @param {object} deps { runOptimize } — 단축키 Ctrl+R 이 호출할 콜백
 */
function init(deps) {
  // 전역 단축키 -> main 프로세스 -> IPC
  ipcRenderer.on('toggle-optimizer', guard('ipc', () => togglePanel('optimizer')));
  ipcRenderer.on('toggle-builds', guard('ipc', () => togglePanel('builds')));
  ipcRenderer.on('toggle-team', guard('ipc', () => togglePanel('team')));
  ipcRenderer.on('run-optimize', guard('ipc', () => deps.runOptimize()));
  ipcRenderer.on('toggle-hotkey-bar', () => {
    document.getElementById('hotkey-bar').classList.toggle('hidden');
  });

  // 인게임 Unity 플러그인 WebSocket 단축키 수신 (게임 전체화면 / 관리자 권한 환경 이중 보장)
  const ws = require('./ws');
  ws.on('hotkey', guard('ws-hotkey', (data, msg) => {
    const action = (msg && msg.action) || (data && data.action);
    if (action === 'toggle-optimizer') togglePanel('optimizer');
    else if (action === 'toggle-builds') togglePanel('builds');
    else if (action === 'toggle-team') togglePanel('team');
    else if (action === 'run-optimize') deps.runOptimize();
    else if (action === 'toggle-hotkey-bar') {
      document.getElementById('hotkey-bar').classList.toggle('hidden');
    }
  }));

  // 단축키 바 마우스 퀵버튼 클릭 이벤트
  document.querySelectorAll('#hotkey-bar .hotkey-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', guard('hotkey-bar-click', e => {
      e.stopPropagation();
      const panel = btn.getAttribute('data-panel');
      if (panel) togglePanel(panel);
    }));
  });
  const btnToggleBar = document.getElementById('btn-toggle-bar');
  if (btnToggleBar) {
    btnToggleBar.addEventListener('click', guard('hotkey-bar-close', e => {
      e.stopPropagation();
      document.getElementById('hotkey-bar').classList.add('hidden');
    }));
  }

  // 언어 변경 토글 (KO <-> EN)
  const i18n = require('./i18n');
  const btnToggleLang = document.getElementById('btn-toggle-lang');
  if (btnToggleLang) {
    const langText = document.getElementById('current-lang-text');
    if (langText) langText.textContent = i18n.getLanguage().toUpperCase();
    btnToggleLang.addEventListener('click', guard('lang-toggle', e => {
      e.stopPropagation();
      const next = i18n.getLanguage() === 'ko' ? 'en' : 'ko';
      i18n.setLanguage(next);
      if (langText) langText.textContent = next.toUpperCase();
      updateAllPanelTexts();
    }));
  }

  i18n.onLanguageChange(() => {
    updateAllPanelTexts();
  });
  updateAllPanelTexts();

  refreshOpenPanelCount();
  setupMousePassthrough();
  setupPanelDragging();
}

function updateAllPanelTexts() {
  const i18n = require('./i18n');
  const lang = i18n.getLanguage();

  // 1. Optimizer Panel
  const optTitle = document.querySelector('#panel-optimizer .panel-head .title');
  if (optTitle) optTitle.textContent = i18n.t('panel.optimizer');
  const optDragHint = document.querySelector('#panel-optimizer .drag-hint');
  if (optDragHint) optDragHint.textContent = i18n.t('panel.dragHint');

  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) btnRefresh.textContent = i18n.t('opt.refresh');
  const btnAddCombo = document.getElementById('btn-add-combo');
  if (btnAddCombo) btnAddCombo.textContent = i18n.t('opt.addCombo');

  const viewCur = document.querySelector('#view-seg [data-view="current"]');
  if (viewCur) viewCur.textContent = `👁 ${i18n.t('opt.viewCurrent')}`;
  const viewOpt = document.querySelector('#view-seg [data-view="optimized"]');
  if (viewOpt) viewOpt.textContent = `⚡ ${i18n.t('opt.viewOptimized')}`;

  // 2. Builds Panel
  const buildsTitle = document.querySelector('#panel-builds .panel-head .title');
  if (buildsTitle) buildsTitle.textContent = i18n.t('panel.builds');
  const buildsDragHint = document.querySelector('#panel-builds .drag-hint');
  if (buildsDragHint) buildsDragHint.textContent = i18n.t('panel.dragHint');

  const tabAll = document.querySelector('.build-tab[data-tab="all"]');
  if (tabAll) tabAll.textContent = i18n.t('builds.tabAll');
  const tabFav = document.querySelector('.build-tab[data-tab="fav"]');
  if (tabFav) {
    const favCount = document.getElementById('fav-count');
    tabFav.innerHTML = `⭐ ${i18n.t('builds.tabFav')} <span id="fav-count" class="tab-count">${favCount ? favCount.textContent : '0'}</span>`;
  }

  // 3. Team Panel
  const teamTitle = document.querySelector('#panel-team .panel-head .title');
  if (teamTitle) teamTitle.textContent = i18n.t('panel.team');
  const teamDragHint = document.querySelector('#panel-team .drag-hint');
  if (teamDragHint) teamDragHint.textContent = i18n.t('panel.dragHint');

  // 4. Hotkey Bar
  const hbOpt = document.querySelector('#hotkey-bar [data-panel="optimizer"]');
  if (hbOpt) hbOpt.innerHTML = i18n.t('hotkey.optimizer');
  const hbBuilds = document.querySelector('#hotkey-bar [data-panel="builds"]');
  if (hbBuilds) hbBuilds.innerHTML = i18n.t('hotkey.builds');
  const hbTeam = document.querySelector('#hotkey-bar [data-panel="team"]');
  if (hbTeam) hbTeam.innerHTML = i18n.t('hotkey.team');
  const btnToggleBar = document.getElementById('btn-toggle-bar');
  if (btnToggleBar) btnToggleBar.innerHTML = i18n.t('hotkey.hide');

  const langText = document.getElementById('current-lang-text');
  if (langText) langText.textContent = lang.toUpperCase();
}

// ── 마우스 통과 ───────────────────────────────────────
//
// 패널 위에 있을 때만 클릭을 받고, 나머지 영역은 게임으로 흘려보낸다.
// 통과 모드에서도 마우스 '이동' 은 계속 전달받으므로(forward: true) 커서가
// 패널에 들어온 순간을 감지할 수 있다. 다만 게임 플레이 중에는 초당 수백 번
// 들어오는 이벤트라, 프레임당 한 번으로 묶고 열린 패널이 없으면 아예 건너뛴다.

function setupMousePassthrough() {
  let ignoring = true;
  let pending = null;   // rAF 예약

  const apply = next => {
    if (next === ignoring) return;
    ignoring = next;
    ipcRenderer.send('set-ignore-mouse-events', ignoring, { forward: true });
  };

  const evaluate = target => {
    if (dragging) { apply(false); return; }
    if (openPanelCount === 0) { apply(true); return; }
    apply(!target.closest('.interactive-ui:not(.hidden)'));
  };

  document.addEventListener('mousemove', e => {
    if (pending) return;
    const target = e.target;
    pending = requestAnimationFrame(() => {
      pending = null;
      evaluate(target);
    });
  });
}

// ── 패널 드래그 이동 ──────────────────────────────────

function setupPanelDragging() {
  let activePanel = null;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  document.querySelectorAll('[data-drag]').forEach(handle => {
    const panel = handle.closest('.panel');
    if (!panel) return;

    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button') || e.target.closest('.panel-btn')) return;

      activePanel = panel;
      dragging = true;
      startX = e.screenX;
      startY = e.screenY;
      const r = panel.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;

      // right/bottom 기준으로 배치된 패널을 left/top 기준으로 전환
      panel.style.left = `${originLeft}px`;
      panel.style.top = `${originTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';

      // 드래그 중인 패널을 최상단으로 올림
      document.querySelectorAll('.panel').forEach(p => {
        if (p === panel) p.style.zIndex = '20';
        else if (p.style.zIndex === '20') p.style.zIndex = '10';
      });

      e.preventDefault();
    });
  });

  // 단일 전역 mousemove 로 현재 드래그 중인 단 하나의 패널만 이동
  window.addEventListener('mousemove', e => {
    if (!dragging || !activePanel) return;
    activePanel.style.left = `${originLeft + (e.screenX - startX)}px`;
    activePanel.style.top = `${originTop + (e.screenY - startY)}px`;
  });

  // 어느 패널을 끌었든 여기서 한 번에 푼다
  window.addEventListener('mouseup', () => {
    dragging = false;
    activePanel = null;
  });
}

module.exports = { init };
