// 오버레이 껍데기: 패널 토글, 전역 단축키 IPC, 마우스 통과, 패널 드래그.

'use strict';

const { ipcRenderer } = require('electron');
const { log, guard } = require('./util');

const PANELS = {
  optimizer: 'panel-optimizer',
  builds: 'panel-builds',
  team: 'panel-team',
};

function togglePanel(name) {
  const el = document.getElementById(PANELS[name]);
  if (!el) { log.error('panel', '패널 없음', name); return; }
  el.classList.toggle('hidden');
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

  setupMousePassthrough();
  setupPanelDragging();
}

// ── 마우스 통과 ───────────────────────────────────────
// 패널 위에 있을 때만 클릭을 받고, 나머지 영역은 게임으로 흘려보낸다.

function setupMousePassthrough() {
  let ignoring = true;

  document.addEventListener('mousemove', e => {
    const overUi = !!e.target.closest('.interactive-ui:not(.hidden)');
    if (overUi === !ignoring) return; // 상태 변화 없음
    ignoring = !overUi;
    ipcRenderer.send('set-ignore-mouse-events', ignoring, { forward: true });
  });
}

// ── 패널 드래그 이동 ──────────────────────────────────

function setupPanelDragging() {
  document.querySelectorAll('[data-drag]').forEach(handle => {
    const panel = handle.closest('.panel');
    let startX, startY, originLeft, originTop, dragging = false;

    handle.addEventListener('mousedown', e => {
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
      e.preventDefault();
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = `${originLeft + (e.screenX - startX)}px`;
      panel.style.top = `${originTop + (e.screenY - startY)}px`;
    });

    window.addEventListener('mouseup', () => { dragging = false; });
  });
}

module.exports = { init };
