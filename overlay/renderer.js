// Sephiria 오버레이 렌더러
//
// 두 가지 데이터 원천을 쓴다:
//  1. 플러그인 WebSocket (ws://localhost:5827) — 실시간 인벤토리/맵
//  2. 로컬 assets/ — 플러그인이 덤프한 아이콘·아이템 DB (오프라인)
//  + 위키 API — 빌드 목록 (main 프로세스가 대신 받아온다. CORS/UA 회피)

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('./logger').create('renderer');
const engine = require('./optimizer');

// 렌더러에서 터진 예외는 화면에 아무 흔적도 남기지 않는다. 전부 로그로 밀어넣는다.
window.addEventListener('error', e => {
  log.error('window', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`,
            e.error && e.error.stack ? e.error.stack.split('\n').slice(1, 4).join(' | ') : undefined);
});
window.addEventListener('unhandledrejection', e => {
  log.error('promise', String((e.reason && e.reason.message) || e.reason));
});

/** 핸들러에서 예외가 나도 오버레이 전체가 멈추지 않도록 감싼다. */
function guard(scope, fn) {
  return function (...args) {
    try { return fn.apply(this, args); }
    catch (err) { log.exception(scope, err); }
  };
}

const WS_URL = 'ws://localhost:5827';
// 이미지 src 용 상대경로
const ASSETS = '../assets';
// 파일 읽기용 절대경로. file:// 에서는 fetch 가 막히므로 JSON 은 fs 로 읽는다.
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, relPath), 'utf8'));
}

// ── 상태 ──────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

let itemDb = null;          // assets/database.json
let comboList = [];         // 활성 콤보 목록

// inventory = 플러그인이 계속 보내주는 최신 상태 (조용히 갱신만 한다)
// displayed = 격자에 실제로 그려지는 스냅샷.
//   이 패널의 목적은 실시간 감시가 아니라 '목표 배치를 보고 따라하는 것'이라
//   새로고침/계산완료 때만 교체한다. 따라하는 도중에 화면이 바뀌면 안 된다.
let inventory = null;
let displayed = null;
let displayedKind = 'none';  // none | current | optimized

let team = [];              // 팀원 목록
let teamActive = 0;         // 선택된 팀원 탭

let lastOptimize = null;    // 마지막 계산 결과 (계산 중에도 유지)
let optimizeState = 'idle'; // idle | calculating | done | error
let optimizeErrorMsg = '';
let calcSeq = 0;            // 계산 요청 일련번호. 재시작 시 옛 응답을 버리는 데 쓴다

// 새로고침은 '다음 inventory_update 를 기다리는' 비동기 동작이다.
let pendingRefresh = null;      // { timer }
let refreshState = 'idle';      // idle | loading | error
let refreshErrorMsg = '';

let priority = [];          // 콤보 우선순위 (id 배열)
let enhanceMode = 'combo';  // combo | even

let builds = [];
let buildDetail = null;
let buildTab = 'all';           // all | fav

// 즐겨찾기는 편의 기능이라 잃어버려도 상관없다. localStorage 로 충분하다.
const FAV_KEY = 'sephiria.favBuilds';
let favorites = loadFavorites();

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Map(arr.map(b => [b.postUuid || String(b.id), b]));
  } catch (err) {
    log.warn('fav', '즐겨찾기 로드 실패 — 비우고 시작', err.message);
    return new Map();
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favorites.values()]));
    log.info('fav', '저장', { 개수: favorites.size });
  } catch (err) {
    log.warn('fav', '저장 실패', err.message);
  }
}

function buildKey(b) {
  return b.postUuid || String(b.id);
}

function isFav(b) {
  return favorites.has(buildKey(b));
}

function toggleFav(b) {
  const k = buildKey(b);
  if (favorites.has(k)) {
    favorites.delete(k);
    log.info('fav', '해제', b.title);
  } else {
    // 목록이 사라져도 즐겨찾기 탭에서 볼 수 있도록 빌드 전체를 저장한다
    favorites.set(k, b);
    log.info('fav', '추가', b.title);
  }
  saveFavorites();
  updateFavCount();
  renderBuildList();
}

function updateFavCount() {
  const el = document.getElementById('fav-count');
  if (el) el.textContent = String(favorites.size);
}

// ── 부팅 ──────────────────────────────────────────────

(function init() {
  log.info('init', '오버레이 시작');
  loadItemDb();
  renderComboPriority();
  renderOptimizerGrid();
  connectWs();
  setupHotkeyIpc();
  setupMousePassthrough();
  setupPanelDragging();
  setupControls();
  loadBuilds();
  log.info('init', '초기화 완료', { 로그파일: log.path });
})();

function loadItemDb() {
  try {
    itemDb = readJson('database.json');
    comboList = (itemDb.combos || []).filter(c => c.isEnabled !== false);
    log.info('db', '아이템 DB 로드', { 아이템: itemDb.items.length, 콤보: comboList.length });
  } catch (err) {
    log.error('db', 'database.json 로드 실패 — 플러그인이 아직 덤프하지 않았을 수 있음', err.message);
    itemDb = { items: [], combos: [] };
  }
}

function itemById(id) {
  if (!itemDb) return null;
  return itemDb.items.find(i => i.id === id) || null;
}

function comboById(id) {
  return comboList.find(c => c.id === id) || null;
}

// ── WebSocket ─────────────────────────────────────────

function connectWs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log.info('ws', '연결됨', WS_URL);
    setWsStatus(true);
    send({ type: 'refresh' });
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch (err) { log.error('ws', '수신 JSON 파싱 실패', String(ev.data).slice(0, 120)); return; }
    try { handleMessage(msg); }
    catch (err) { log.exception('ws:handle', err); }
  };

/** WebSocket 전송. 끊겨 있으면 false 를 돌려주고 로그를 남긴다. */
function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log.warn('ws', '전송 실패 — 연결 안 됨', obj && obj.type);
    return false;
  }
  try {
    ws.send(JSON.stringify(obj));
    log.info('ws', '전송', obj && obj.type);
    return true;
  } catch (err) {
    log.exception('ws:send', err);
    return false;
  }
}

  ws.onerror = () => { log.warn('ws', '소켓 오류'); setWsStatus(false); };
  ws.onclose = () => { log.warn('ws', '연결 끊김 — 재접속 예약'); setWsStatus(false); scheduleReconnect(); };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, 2000);
}

function setWsStatus(connected) {
  const el = document.getElementById('ws-status');
  el.classList.toggle('connected', connected);
  el.classList.toggle('disconnected', !connected);
  document.getElementById('ws-status-text').textContent =
    connected ? '게임 연결됨' : '게임 연결 끊김 — 재시도 중';
}

function handleMessage(msg) {
  if (msg.type === 'inventory_update') {
    const first = inventory === null;
    inventory = msg.data;

    if (first) {
      log.info('inv', '첫 인벤토리 수신', {
        격자: `${inventory.width}x${inventory.height}`,
        storage: inventory.storage,
        아이템: (inventory.items || []).length
      });
    }

    // 새로고침을 기다리고 있었다면 지금 완료시킨다
    if (pendingRefresh) {
      clearTimeout(pendingRefresh.timer);
      pendingRefresh = null;
      applyRefresh();
      log.info('refresh', '완료 (서버 응답 수신)');
    } else if (first && displayedKind === 'none') {
      // 최초 1회는 자동으로 채워준다
      applyRefresh();
    }

    if (buildDetail) renderBuildDetail(buildDetail); // 보유 표시만 갱신

  } else if (msg.type === 'optimize_data') {
    // 재시작된 계산이라면 옛 스냅샷은 버린다
    if (msg.data && msg.data.seq != null && msg.data.seq !== calcSeq) {
      log.info('optimize', '옛 스냅샷 무시', { 받음: msg.data.seq, 현재: calcSeq });
      return;
    }
    runSearch(msg.data);

  } else if (msg.type === 'optimize_error') {
    if (msg.data && msg.data.seq != null && msg.data.seq !== calcSeq) return;
    optimizeState = 'error';
    optimizeErrorMsg = (msg.data && msg.data.message) || '계산 실패';
    log.error('optimize', '플러그인 오류', optimizeErrorMsg);
    renderOptimizeStatus();

  } else if (msg.type === 'team_update') {
    team = (msg.data && msg.data.members) || [];
    if (teamActive >= team.length) teamActive = 0;
    renderTeam();
  }
}

/**
 * 플러그인이 넘긴 스냅샷으로 실제 탐색을 돌린다.
 *
 * 탐색은 여기(오버레이)에서 한다. 플러그인은 게임 상태를 읽어 넘기기만 하고
 * 게임을 건드리지 않는다. 알고리즘을 고칠 때 게임을 재시작할 필요가 없다.
 */
function runSearch(snap) {
  const t0 = Date.now();

  try {
    const ctx = engine.prepare(snap);

    // 우선순위 콤보 -> 가중치. 아이템의 콤보 소속은 로컬 DB(추출본)에서 읽는다.
    const weightOf = engine.makeWeightFn(priority, item => {
      const db = itemById(item.eid);
      return (db && db.categories) || [];
    });

    const opts = { mode: enhanceMode, weightOf, iterations: 30000 };

    // 담금질은 초기값에 따라 국소해에 갇힌다. 여러 번 돌려 가장 좋은 것을 쓴다.
    // 실측 30000회에 약 90ms 라 몇 번 반복해도 체감되지 않는다.
    let best = null;
    const RESTARTS = 5;
    for (let k = 0; k < RESTARTS; k++) {
      const r = engine.optimize(ctx, opts);
      if (!best || r.bestScore > best.bestScore) best = r;
    }

    displayed = layoutFromSearch(ctx, best);
    displayedKind = 'optimized';

    lastOptimize = {
      _at: Date.now(),
      startScore: best.startScore,
      bestScore: best.bestScore,
      moves: countMoves(ctx, best.placement),
    };
    optimizeState = 'done';

    log.info('optimize', '탐색 완료', {
      ms: Date.now() - t0,
      점수: `${best.startScore} -> ${best.bestScore}`,
      이동: lastOptimize.moves,
      아이템: ctx.items.length,
      석판: ctx.patterns.length,
    });

  } catch (err) {
    optimizeState = 'error';
    optimizeErrorMsg = err.message || String(err);
    log.exception('optimize:search', err);
  }

  renderOptimizeStatus();
  renderOptimizerGrid();
}

/** 원래 자리에서 옮겨야 하는 아이템 수 */
function countMoves(ctx, placement) {
  let n = 0;
  for (let i = 0; i < ctx.items.length; i++) {
    if (placement[i] !== ctx.items[i].homeIdx) n++;
  }
  return n;
}

/** 탐색 결과를 격자 렌더러가 이해하는 스냅샷 형태로 바꾼다. */
function layoutFromSearch(ctx, res) {
  const { width, storage, height } = ctx;
  const { level, active } = res.evaluation;

  return {
    width, storage, height,
    items: ctx.items.map((it, i) => {
      const cell = res.placement[i];
      return {
        instanceID: it.iid,
        entityID: it.eid,
        name: it.name,
        x: cell % width,
        y: (cell / width) | 0,
        // 표시할 값은 실제 효과에 쓰이는 레벨 (상한으로 자른 값)
        level: Math.max(0, Math.min(level[cell], it.maxLevel)),
        maxLevel: it.maxLevel,
        isActive: it.kind === 'charm' ? active[cell] === 1 : true,
        activateCriteria: it.criteria,
      };
    }),
  };
}

/**
 * 새로고침 요청. 서버에 최신 인벤토리를 달라고 하고, 응답이 올 때까지 로딩을 띄운다.
 * 응답이 오면 handleMessage 가 applyRefresh() 를 부른다.
 */
function requestRefresh() {
  log.info('refresh', '요청', { 연결: !!(ws && ws.readyState === WebSocket.OPEN), 캐시있음: !!inventory });

  if (pendingRefresh) {
    log.info('refresh', '이미 진행 중 — 무시');
    return;
  }

  const sent = send({ type: 'refresh' });

  if (!sent) {
    // 연결이 없으면 가진 캐시라도 반영해 준다
    if (inventory) {
      applyRefresh();
      log.warn('refresh', '연결이 없어 캐시된 인벤토리로 갱신');
    } else {
      setRefreshError('게임에 연결되지 않았습니다');
      log.error('refresh', '연결 없음 + 캐시 없음');
    }
    return;
  }

  refreshState = 'loading';
  renderOptimizeStatus();

  // 서버가 응답하지 않을 수도 있으므로 시간 제한을 둔다
  pendingRefresh = {
    timer: setTimeout(() => {
      pendingRefresh = null;
      if (inventory) {
        applyRefresh();
        log.warn('refresh', '응답 지연 — 캐시된 인벤토리로 갱신');
      } else {
        setRefreshError('인벤토리를 받지 못했습니다');
        log.error('refresh', '타임아웃 + 캐시 없음');
      }
    }, 3000)
  };
}

function setRefreshError(msg) {
  refreshState = 'error';
  refreshErrorMsg = msg;
  renderOptimizeStatus();
}

/** 최신 인벤토리를 격자에 반영하고, 발동 중인 콤보를 우선순위 기본값으로 채운다. */
function applyRefresh() {
  if (!inventory) { log.warn('refresh', 'applyRefresh 호출됐지만 인벤토리 없음'); return; }

  displayed = inventory;
  displayedKind = 'current';
  refreshState = 'idle';

  applyActiveCombosAsPriority();
  renderComboPriority();
  renderOptimizerGrid();
  renderOptimizeStatus();

  log.info('refresh', '격자 갱신', {
    아이템: (inventory.items || []).length,
    우선순위: priority.join(',') || '(없음)'
  });
}

/**
 * 지금 인벤토리에서 실제로 발동 중인 콤보를 우선순위로 세팅한다.
 * 콤보 단계는 '보유 개수'로 정해지므로 setEffects 의 count 를 그대로 쓴다.
 * 개수가 많은 콤보가 위로 온다.
 */
function applyActiveCombosAsPriority() {
  const effects = (inventory && inventory.setEffects) || [];
  if (effects.length === 0) return;

  const active = effects
    .map(e => {
      const combo = comboById(e.name);
      const tiers = (combo && combo.comboTiers) || [];
      const minCount = tiers.length ? Math.min.apply(null, tiers.map(t => t.count)) : 2;
      return { id: e.name, count: e.count, ok: e.count >= minCount && !!combo };
    })
    .filter(x => x.ok)
    .sort((a, b) => b.count - a.count)
    .map(x => x.id);

  if (active.length > 0) {
    priority = active;
    log.info('combo', '발동 중인 콤보를 우선순위로 설정', active.join(','));
  } else {
    log.info('combo', '발동 중인 콤보 없음', { setEffects: effects.length });
  }
}

// ── 최적 배치 패널 ────────────────────────────────────

/** 인벤토리 격자를 그린다. layout 이 주어지면 그 배치로, 없으면 현재 배치로. */
function renderOptimizerGrid() {
  const grid = document.getElementById('opt-grid');
  const caption = document.getElementById('grid-caption');

  if (!displayed) {
    grid.style.gridTemplateColumns = '';
    grid.innerHTML = '<div class="empty">게임에서 인벤토리를 연 뒤 새로고침을 누르세요</div>';
    caption.textContent = '새로고침을 눌러 현재 인벤토리를 불러오세요';
    return;
  }

  caption.textContent = displayedKind === 'optimized'
    ? '아이콘 = 목표 위치 · 노란 숫자 = 최종 강화수'
    : '현재 배치 · 노란 숫자 = 현재 강화수';

  renderGridInto(grid, displayed);
}

/**
 * 인벤토리 스냅샷을 격자 DOM 으로 그린다. 최적배치 패널과 팀원 패널이 공유한다.
 *
 * 격자는 직사각형이 아니다: Height = ceil(storage / Width) 이므로
 * 마지막 줄은 부분적으로만 존재할 수 있고, 없는 칸은 빗금으로 표시한다.
 * 포션 벨트(y = 100)처럼 격자 밖 슬롯은 제외한다.
 */
function renderGridInto(gridEl, snap) {
  gridEl.innerHTML = '';

  if (!snap) {
    gridEl.style.gridTemplateColumns = '';
    gridEl.innerHTML = '<div class="empty">데이터 없음</div>';
    return;
  }

  const w = snap.width || 6;
  const storage = snap.storage || (w * (snap.height || 6));
  const h = Math.ceil(storage / w);

  gridEl.style.gridTemplateColumns = `repeat(${w}, auto)`;

  const byPos = {};
  for (const it of (snap.items || [])) {
    if (it.x < 0 || it.x >= w || it.y < 0 || it.y >= h) continue;
    if (it.y * w + it.x >= storage) continue;
    byPos[`${it.x},${it.y}`] = it;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';

      if (y * w + x >= storage) {
        cell.classList.add('void');
        gridEl.appendChild(cell);
        continue;
      }

      const it = byPos[`${x},${y}`];
      if (it) {
        const db = itemById(it.entityID);
        const isTablet = db && db.type === 'StoneTablet';
        if (isTablet) cell.classList.add('tablet');
        if (it.isActive === false) cell.classList.add('inactive');

        const img = document.createElement('img');
        img.src = `${ASSETS}/icons/${it.entityID}.png`;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        cell.appendChild(img);

        if (!isTablet) {
          const lv = document.createElement('span');
          lv.className = 'lv';
          lv.textContent = it.level;
          cell.appendChild(lv);
        }

        cell.title = `${it.name} — ${it.level}/${it.maxLevel}강` +
          (it.activateCriteria && it.activateCriteria !== 'Always' ? ` [${it.activateCriteria}]` : '') +
          (it.isActive === false ? ' (비활성)' : '');
      }

      gridEl.appendChild(cell);
    }
  }
}

function renderOptimizeStatus() {
  const badge = document.getElementById('opt-badge');
  const note = document.getElementById('opt-stale-note');
  const btn = document.getElementById('btn-calc');

  const CALC_LABEL = '\u25B6 계산 <small>(Ctrl+R)</small>';
  const refreshBtn = document.getElementById('btn-refresh');

  badge.className = 'status-badge';
  note.classList.add('hidden');
  btn.disabled = false;   // 계산 중에도 다시 누를 수 있어야 한다

  // 새로고침도 계산과 같은 로딩 UI 를 쓴다
  if (refreshState === 'loading') {
    refreshBtn.innerHTML = '<span class="spinner"></span> 불러오는 중';
    refreshBtn.disabled = true;
  } else {
    refreshBtn.innerHTML = '\u27F3 새로고침';
    refreshBtn.disabled = false;
  }

  if (refreshState === 'loading') {
    badge.classList.add('calc');
    badge.innerHTML = '<span class="spinner"></span> 인벤토리 불러오는 중…';
    if (displayed) note.classList.remove('hidden');
    return;
  }

  if (refreshState === 'error') {
    badge.classList.add('error');
    badge.textContent = refreshErrorMsg || '새로고침 실패';
    return;
  }

  if (optimizeState === 'calculating') {
    badge.classList.add('calc');
    badge.innerHTML = '<span class="spinner"></span> 계산 중…';
    btn.innerHTML = '\u21BB 다시 계산';
    if (lastOptimize) note.classList.remove('hidden');
  } else if (optimizeState === 'done') {
    badge.classList.add('done');
    const moves = lastOptimize.moves;
    badge.textContent = moves === 0
      ? `✓ ${formatAgo(lastOptimize._at)} · 이미 최적입니다`
      : `✓ ${formatAgo(lastOptimize._at)} · ${moves}개 이동`;
    btn.innerHTML = CALC_LABEL;
  } else if (optimizeState === 'error') {
    badge.classList.add('error');
    badge.textContent = optimizeErrorMsg || '계산 실패';
    btn.innerHTML = CALC_LABEL;
  } else {
    badge.classList.add('idle');
    badge.textContent = '계산한 적 없음';
    btn.innerHTML = CALC_LABEL;
  }
}

function formatAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '방금';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
}

// 상태 배지의 '몇 분 전' 을 갱신
setInterval(() => { if (optimizeState === 'done') renderOptimizeStatus(); }, 30000);

function requestOptimize() {
  // 계산 중에 다시 누르면 이전 요청을 버리고 처음부터 다시 시작한다
  calcSeq++;
  log.info('optimize', '요청', { seq: calcSeq, mode: enhanceMode, priority: priority.join(',') || '(없음)' });

  const sent = send({
    type: 'optimize',
    seq: calcSeq,
    priority: priority,
    mode: enhanceMode
  });

  if (!sent) {
    optimizeState = 'error';
    renderOptimizeStatus();
    return;
  }

  optimizeState = 'calculating';
  renderOptimizeStatus();
}

// ── 콤보 우선순위 ─────────────────────────────────────

function renderComboPriority() {
  const list = document.getElementById('combo-priority');
  list.innerHTML = '';

  priority.forEach((id, idx) => {
    const c = comboById(id);
    const row = document.createElement('div');
    row.className = 'prio-row';
    row.draggable = true;
    row.dataset.id = id;
    row.innerHTML =
      `<span class="handle">≡</span><span class="rank">${idx + 1}</span>` +
      `<img src="${ASSETS}/combos/${id}.png" onerror="this.style.visibility='hidden'">` +
      `<span>${c ? c.name : id}</span><span class="x">✕</span>`;

    row.querySelector('.x').addEventListener('click', e => {
      e.stopPropagation();
      priority = priority.filter(p => p !== id);
      renderComboPriority();
    });

    row.addEventListener('dragstart', () => row.classList.add('dragging'));
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      priority = [...list.querySelectorAll('.prio-row')].map(r => r.dataset.id);
      renderComboPriority();
    });

    list.appendChild(row);
  });

  list.addEventListener('dragover', onPriorityDragOver);
}

function onPriorityDragOver(e) {
  e.preventDefault();
  const list = e.currentTarget;
  const dragging = list.querySelector('.dragging');
  if (!dragging) return;

  const after = [...list.querySelectorAll('.prio-row:not(.dragging)')].find(row => {
    const box = row.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });

  if (after) list.insertBefore(dragging, after);
  else list.appendChild(dragging);
}

function renderComboPicker() {
  const picker = document.getElementById('combo-picker');
  picker.innerHTML = '';

  comboList
    .filter(c => !priority.includes(c.id))
    .forEach(c => {
      const el = document.createElement('div');
      el.className = 'combo-opt';
      el.innerHTML =
        `<img src="${ASSETS}/combos/${c.id}.png" onerror="this.style.visibility='hidden'">` +
        `<span>${c.name}</span>`;
      el.addEventListener('click', () => {
        priority.push(c.id);
        picker.classList.add('hidden');
        renderComboPriority();
      });
      picker.appendChild(el);
    });
}

// ── 위키 빌드 ─────────────────────────────────────────

async function loadBuilds() {
  const list = document.getElementById('build-list');
  list.innerHTML = '<div class="empty">불러오는 중…</div>';

  const sort = document.getElementById('build-sort').value;
  const latestOnly = document.getElementById('build-latest-only').checked;
  const weapon = document.getElementById('build-weapon').value;

  try {
    // 위키는 봇 UA 를 403 처리하므로 main 프로세스가 대신 받아온다
    builds = await ipcRenderer.invoke('fetch-builds', { sort, latestOnly, weapon });
    log.info('builds', '목록 수신', { 개수: builds.length, sort, latestOnly, weapon: weapon || '전체' });
    renderBuildList();
  } catch (err) {
    log.error('builds', '목록 요청 실패', err.message || String(err));
    list.innerHTML = `<div class="empty">빌드를 불러오지 못했습니다<br><small>${err.message || err}</small></div>`;
  }
}

function renderBuildList() {
  const list = document.getElementById('build-list');
  const q = document.getElementById('build-search').value.trim().toLowerCase();

  const source = buildTab === 'fav' ? [...favorites.values()] : builds;
  const shown = source.filter(b => !q || (b.title || '').toLowerCase().includes(q));

  if (shown.length === 0) {
    list.innerHTML = buildTab === 'fav'
      ? '<div class="empty">즐겨찾기한 빌드가 없습니다<br><small>카드의 ☆ 를 눌러 추가하세요</small></div>'
      : '<div class="empty">결과가 없습니다</div>';
    return;
  }

  list.innerHTML = '';
  for (const b of shown) {
    list.appendChild(buildCard(b));
  }
}

/**
 * 빌드 카드.
 * 텍스트만으로는 빌드가 구분되지 않으므로 코스튬·무기·기적을 아이콘으로 보여준다.
 * 이름은 툴팁으로 충분하다.
 */
function buildCard(b) {
  const card = document.createElement('div');
  card.className = 'build-card';

  const fav = document.createElement('span');
  fav.className = 'fav-btn' + (isFav(b) ? ' on' : '');
  fav.textContent = isFav(b) ? '★' : '☆';
  fav.title = isFav(b) ? '즐겨찾기 해제' : '즐겨찾기 추가';
  fav.addEventListener('click', guard('fav', e => { e.stopPropagation(); toggleFav(b); }));

  const iconRow = document.createElement('div');
  iconRow.className = 'bc-icons';
  for (const [cat, slug, label] of [
    ['costume', b.costume, '코스튬'],
    ['weapons', b.weapon, '무기'],
    ['miracle', b.miracle, '기적'],
  ]) {
    if (!slug) continue;
    const box = document.createElement('span');
    box.className = 'bc-icon ' + cat;
    box.title = `${label}: ${slugName(cat, slug)}`;
    const img = document.createElement('img');
    img.src = slugIcon(cat, slug);
    img.onerror = () => { box.classList.add('missing'); img.remove(); };
    box.appendChild(img);
    iconRow.appendChild(box);
  }

  // 목표 콤보도 아이콘으로
  const comboRow = document.createElement('span');
  comboRow.className = 'bc-combos';
  for (const c of (b.combo || [])) {
    const key = comboKeyFromWikiSlug(c);
    const img = document.createElement('img');
    img.src = `${ASSETS}/combos/${key}.png`;
    img.title = (comboById(key) || {}).name || c;
    img.onerror = () => img.remove();
    comboRow.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'bc-body';
  body.innerHTML =
    `<div class="bc-title">${esc(b.title)}</div>` +
    `<div class="bc-meta">` +
    `<span>${esc((b.writer && b.writer.nickname) || '')}</span>` +
    `<span class="bc-like">♥ ${b.postLike != null ? b.postLike : 0}</span>` +
    `<span>v${esc(b.version || '')}</span>` +
    `</div>`;
  body.querySelector('.bc-meta').appendChild(comboRow);

  card.appendChild(fav);
  card.appendChild(iconRow);
  card.appendChild(body);

  card.addEventListener('click', guard('card', () => {
    buildDetail = b;
    document.getElementById('build-list-view').classList.add('hidden');
    document.getElementById('build-detail-view').classList.remove('hidden');
    renderBuildDetail(b);
  }));

  return card;
}

const ABILITY_LABELS = {
  base: '기본', will: '의지', anger: '분노', rapid: '신속',
  wisdom: '지혜', patience: '인내', survival: '생존'
};

function renderBuildDetail(b) {
  const view = document.getElementById('build-detail-view');

  const ownedNames = new Set(
    (inventory?.items || []).map(i => (i.name || '').replace(/\s/g, ''))
  );

  const abilities = Object.entries(ABILITY_LABELS).map(([k, label]) => {
    const v = b.ability?.[k] ?? 0;
    return `<div class="stat-box"><div class="sn">${label}</div>` +
           `<div class="sv${v === 0 ? ' zero' : ''}">${v}</div></div>`;
  }).join('');

  const combos = (b.combo || []).map(id => {
    const key = comboKeyFromWikiSlug(id);
    return `<span class="combo-badge">` +
           `<img src="${ASSETS}/combos/${key}.png" onerror="this.style.visibility='hidden'">` +
           `${esc(comboById(key)?.name || id)}</span>`;
  }).join('');

  const skewer = (b.fruit_skewer || [])
    .map(f => `${esc(comboById(comboKeyFromWikiSlug(f.key))?.name || f.key)} ${f.value}`)
    .join(' · ');

  const sections = (b.content || []).map(sec => {
    const icons = (sec.items || []).map(it => {
      const kor = slugName('artifacts', it.value);
      const owned = ownedNames.has(kor.replace(/\s/g, ''));
      const local = itemDb?.items.find(i => i.name.replace(/\s/g, '') === kor.replace(/\s/g, ''));
      const src = local
        ? `${ASSETS}/icons/${local.id}.png`
        : `https://img.sephiria.wiki/artifacts/${it.value}.png`;
      return `<span class="it${owned ? ' owned' : ''}" title="${esc(kor)}${owned ? ' (보유 중)' : ''}">` +
             `<img src="${src}"></span>`;
    }).join('');

    return `<div class="item-section">` +
           `<div class="is-label">${esc(sec.label || '')}</div>` +
           `<div class="icon-row">${icons}</div>` +
           (sec.description ? `<div class="is-desc">${esc(sec.description)}</div>` : '') +
           `</div>`;
  }).join('');

  view.innerHTML =
    `<button class="back-btn">← 목록으로</button>` +
    `<div class="bd-title">${esc(b.title)}</div>` +
    `<div class="bd-writer">${esc(b.writer?.nickname || '')} · ♥ ${b.postLike ?? 0} · v${esc(b.version || '')}</div>` +
    `<div class="chip-row">` +
      `<span class="chip">코스튬 <b>${esc(slugName('costume', b.costume))}</b></span>` +
      `<span class="chip">무기 <b>${esc(slugName('weapons', b.weapon))}</b></span>` +
      `<span class="chip">기적 <b>${esc(slugName('miracle', b.miracle))}</b></span>` +
    `</div>` +
    (combos ? `<div class="combo-row">${combos}</div>` : '') +
    `<div class="stat-row">${abilities}</div>` +
    (skewer ? `<div class="chip-row"><span class="chip">🍡 과일꼬치: <b>${esc(skewer)}</b></span></div>` : '') +
    (b.description ? `<div class="bd-desc">${sanitize(b.description)}</div>` : '') +
    sections;

  view.querySelector('.back-btn').addEventListener('click', () => {
    buildDetail = null;
    document.getElementById('build-detail-view').classList.add('hidden');
    document.getElementById('build-list-view').classList.remove('hidden');
    renderBuildList();
  });

  view.querySelector('.fav-btn').addEventListener('click', guard('fav:detail', () => {
    toggleFav(b);
    renderBuildDetail(b);   // 별 모양 갱신
  }));
}

// 위키 콤보 슬러그 -> 로컬 아이콘 키
const WIKI_COMBO_KEY = {
  yinggalbul: 'EMBER', ice_weapon: 'FROST', glacier: 'GLACIER',
  magic_engineering: 'MAGITECH', shadow: 'SHADOW', guardian: 'GUARDIAN',
  spring_song: 'WINDSONG', mystery: 'MYSTIC', planet: 'PLANET',
  colleague: 'COMPANION', precision: 'PRECISION', extrium: 'DARKCLOUD',
  firmness: 'STURDY', lake: 'LAKE', sun_sword: 'FLAMESWORD',
  academy: 'ACADEMY', curse: 'CURSE', bargaining: 'SAVVY',
  element: 'ELEMENTAL', alchemy: 'ALCHEMY'
};
function comboKeyFromWikiSlug(slug) {
  return WIKI_COMBO_KEY[slug] || String(slug || '').toUpperCase();
}

// 슬러그 -> 로컬 아이콘 경로 (assets/wiki/icons/<카테고리>/<슬러그>.png)
let wikiIcons = null;
try {
  const wd = readJson(path.join('wiki', 'wikidata.json')).data;
  wikiIcons = {};
  for (const [cat, items] of Object.entries(wd)) {
    wikiIcons[cat] = {};
    for (const rec of Object.values(items)) {
      if (rec.localIcon) wikiIcons[cat][rec.value] = `${ASSETS}/wiki/icons/${rec.localIcon}`;
    }
  }
} catch (err) {
  wikiIcons = null;
}

/** 위키 카테고리 아이콘. 로컬에 없으면 CDN 으로 폴백한다. */
function slugIcon(category, slug) {
  if (!slug) return null;
  const local = wikiIcons && wikiIcons[category] && wikiIcons[category][slug];
  if (local) return local;
  return `https://img.sephiria.wiki/${category}/${slug}.png`;
}

// 슬러그 -> 한글명 (assets/wiki/slugs.json)
let slugMap = null;
try { slugMap = readJson(path.join('wiki', 'slugs.json')); } catch { /* 없으면 슬러그 그대로 표시 */ }
function slugName(category, slug) {
  if (!slug) return '';
  return slugMap?.[category]?.[slug] || slug;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 위키 본문은 HTML 이다. 태그를 화이트리스트로 제한해 넣는다. */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const allowed = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'SPAN', 'DIV']);
  (function walk(node) {
    for (const child of [...node.children]) {
      walk(child);
      if (!allowed.has(child.tagName)) child.replaceWith(...child.childNodes);
      else [...child.attributes].forEach(a => child.removeAttribute(a.name));
    }
  })(doc.body);
  return doc.body.innerHTML;
}

// ── 팀원 패널 ─────────────────────────────────────────

function renderTeam() {
  const tabs = document.getElementById('team-tabs');
  const body = document.getElementById('team-body');

  if (!team.length) {
    tabs.innerHTML = '';
    body.innerHTML = '<div class="empty">멀티플레이 중이 아니거나<br>팀원 정보가 아직 없습니다</div>';
    return;
  }

  tabs.innerHTML = '';
  team.forEach((member, idx) => {
    const tab = document.createElement('span');
    tab.className = 'team-tab' + (idx === teamActive ? ' on' : '');
    tab.textContent = member.name || `플레이어 ${idx + 1}`;
    tab.addEventListener('click', () => { teamActive = idx; renderTeam(); });
    tabs.appendChild(tab);
  });

  const m = team[teamActive] || team[0];
  body.innerHTML = '';

  const meta = document.createElement('div');
  meta.className = 'team-meta';
  const chips = [];
  if (m.weapon) chips.push(`<span class="chip">무기 <b>${esc(m.weapon)}</b></span>`);
  for (const c of (m.combos || [])) {
    const combo = comboById(c.id || c.name);
    chips.push(
      `<span class="combo-badge">` +
      `<img src="${ASSETS}/combos/${c.id || c.name}.png" onerror="this.style.visibility='hidden'">` +
      `${esc((combo && combo.name) || c.id || c.name)} ${c.count != null ? c.count : ''}</span>`
    );
  }
  meta.innerHTML = chips.join('');
  body.appendChild(meta);

  const grid = document.createElement('div');
  grid.className = 'mini-grid';
  renderGridInto(grid, m.inventory);
  body.appendChild(grid);
}

// ── 패널 토글 / 단축키 ────────────────────────────────

const PANELS = {
  optimizer: 'panel-optimizer',
  builds: 'panel-builds',
  team: 'panel-team'
};

function togglePanel(name) {
  const el = document.getElementById(PANELS[name]);
  if (!el) { log.error('panel', '패널 없음', name); return; }
  el.classList.toggle('hidden');
  log.info('panel', el.classList.contains('hidden') ? `${name} 닫음` : `${name} 열음`);
}

function setupHotkeyIpc() {
  ipcRenderer.on('toggle-optimizer', guard('ipc', () => togglePanel('optimizer')));
  ipcRenderer.on('toggle-builds', guard('ipc', () => togglePanel('builds')));
  ipcRenderer.on('toggle-team', guard('ipc', () => togglePanel('team')));
  ipcRenderer.on('run-optimize', guard('ipc', () => requestOptimize()));
  ipcRenderer.on('toggle-hotkey-bar', () => {
    document.getElementById('hotkey-bar').classList.toggle('hidden');
  });
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

// ── 컨트롤 ────────────────────────────────────────────

function setupControls() {
  document.getElementById('btn-calc').addEventListener('click', requestOptimize);

  document.getElementById('btn-add-combo').addEventListener('click', () => {
    const picker = document.getElementById('combo-picker');
    picker.classList.toggle('hidden');
    if (!picker.classList.contains('hidden')) renderComboPicker();
  });

  document.querySelectorAll('#mode-seg div').forEach(seg => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#mode-seg div').forEach(s => s.classList.remove('on'));
      seg.classList.add('on');
      enhanceMode = seg.dataset.mode;
    });
  });

  document.querySelectorAll('.build-tab').forEach(tab => {
    tab.addEventListener('click', guard('tab', () => {
      document.querySelectorAll('.build-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      buildTab = tab.dataset.tab;
      log.info('builds', '탭 전환', buildTab);
      renderBuildList();
    }));
  });
  updateFavCount();

  document.getElementById('build-search').addEventListener('input', renderBuildList);
  document.getElementById('build-sort').addEventListener('change', loadBuilds);
  document.getElementById('build-latest-only').addEventListener('change', loadBuilds);
  document.getElementById('build-weapon').addEventListener('change', loadBuilds);
}
