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

  refreshOpenPanelCount();
  setupMousePassthrough();
  setupPanelDragging();
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
  document.querySelectorAll('[data-drag]').forEach(handle => {
    const panel = handle.closest('.panel');
    let startX, startY, originLeft, originTop;

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
  });

  // 어느 패널을 끌었든 여기서 한 번에 푼다
  window.addEventListener('mouseup', () => { dragging = false; });
}

module.exports = { init };
