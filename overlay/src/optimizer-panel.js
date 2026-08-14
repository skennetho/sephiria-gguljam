// 최적 배치 패널 (Ctrl+D).
//
// 상태 흐름이 셋 겹쳐 있다. 우선순위는 renderStatus() 의 분기 순서가 정의한다:
//  - refresh:  새로고침 (다음 inventory_update 를 기다리는 비동기 동작)
//  - optimize: 계산 (플러그인에 스냅샷 요청 -> 엔진 탐색)
//  - apply:    반영 (계산 결과를 게임 인벤토리에 전송)
//
// inventory 는 플러그인이 계속 보내주는 최신 상태이고, displayed 는 격자에
// 실제로 그려지는 스냅샷이다. 이 패널의 목적은 실시간 감시가 아니라
// '목표 배치를 보고 따라하는 것'이라 새로고침/계산완료 때만 교체한다.

'use strict';

const engine = require('../optimizer');
const { log, guard, formatAgo } = require('./util');
const { itemById, comboById, combos, ASSETS, RARITY_RANK } = require('./gamedata');
const ws = require('./ws');
const { renderGridInto } = require('./grid');

// ── 상태 ──────────────────────────────────────────────

let inventory = null;
let displayed = null;
let displayedKind = 'none';  // none | current | optimized

let lastOptimize = null;     // 마지막 계산 결과 요약 (계산 중에도 유지)
let optimizeState = 'idle';  // idle | calculating | done | error
let optimizeErrorMsg = '';
let calcSeq = 0;             // 재시작 시 옛 응답을 버리는 일련번호

let lastSearch = null;       // { ctx, placement, rotations } — 반영하기가 쓴다
let applyState = 'idle';     // idle | applying | error
let applySeq = 0;
let applyTimer = null;
let applyErrorMsg = '';

let pendingRefresh = null;   // { timer }
let refreshState = 'idle';   // idle | loading | error
let refreshErrorMsg = '';

let priority = [];           // 콤보 우선순위 (id 배열)
let enhanceMode = 'combo';   // combo | even

/** 다른 모듈이 최신 인벤토리를 읽을 때 (빌드 패널의 보유 표시 등) */
function currentInventory() {
  return inventory;
}

// ── 초기화 ────────────────────────────────────────────

function init() {
  renderPriority();
  renderGrid();

  ws.on('inventory_update', onInventoryUpdate);
  ws.on('optimize_data', onOptimizeData);
  ws.on('optimize_error', onOptimizeError);
  ws.on('apply_result', onApplyResult);

  document.getElementById('btn-calc')
    .addEventListener('click', guard('btn:calc', requestOptimize));

  // 주의: 이 바인딩이 이전 리팩터링에서 유실된 적이 있다 (새로고침 버튼 무반응).
  document.getElementById('btn-refresh')
    .addEventListener('click', guard('btn:refresh', requestRefresh));

  document.getElementById('btn-apply')
    .addEventListener('click', guard('btn:apply', requestApply));

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

  // 상태 배지의 '몇 분 전' 을 갱신
  setInterval(() => { if (optimizeState === 'done') renderStatus(); }, 30000);
}

// ── 수신 처리 ─────────────────────────────────────────

function onInventoryUpdate(data) {
  const first = inventory === null;
  inventory = data;

  if (first) {
    log.info('inv', '첫 인벤토리 수신', {
      격자: `${inventory.width}x${inventory.height}`,
      storage: inventory.storage,
      아이템: (inventory.items || []).length,
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
}

function onOptimizeData(data) {
  // 재시작된 계산이라면 옛 스냅샷은 버린다
  if (data && data.seq != null && data.seq !== calcSeq) {
    log.info('optimize', '옛 스냅샷 무시', { 받음: data.seq, 현재: calcSeq });
    return;
  }
  runSearch(data);
}

function onOptimizeError(data) {
  if (data && data.seq != null && data.seq !== calcSeq) return;
  optimizeState = 'error';
  optimizeErrorMsg = (data && data.message) || '계산 실패';
  log.error('optimize', '플러그인 오류', optimizeErrorMsg);
  renderStatus();
}

function onApplyResult(data) {
  if (data && data.seq != null && data.seq !== applySeq) return;
  if (applyTimer) { clearTimeout(applyTimer); applyTimer = null; }

  if (data && data.ok) {
    log.info('apply', '반영 완료', { 스왑: data.swaps, 회전: data.rotations });
    applyState = 'idle';
    // 반영 결과를 현재 배치로 다시 읽어와 확인시켜 준다
    requestRefresh();
  } else {
    applyState = 'error';
    applyErrorMsg = (data && data.message) || '반영 실패';
    log.error('apply', '반영 실패', applyErrorMsg);
    renderStatus();
  }
}

// ── 탐색 ──────────────────────────────────────────────

/**
 * 플러그인이 넘긴 스냅샷으로 실제 탐색을 돌린다.
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

    // 타이브레이크: 강화수가 같으면 콤보 소속 우선, 그다음 희귀도 순
    const tieOf = item => {
      const db = itemById(item.eid);
      return {
        combo: db && db.categories && db.categories.length > 0 ? 1 : 0,
        rarity: db && RARITY_RANK[db.rarity] != null ? RARITY_RANK[db.rarity] : 0,
      };
    };

    const opts = { mode: enhanceMode, weightOf, tieOf, iterations: 30000 };

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
    lastSearch = { ctx, placement: best.placement, rotations: best.rotations };
    applyState = 'idle';

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

  renderStatus();
  renderGrid();
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

// ── 명령 ──────────────────────────────────────────────

/**
 * 새로고침 요청. 서버에 최신 인벤토리를 달라고 하고, 응답이 올 때까지 로딩을 띄운다.
 * 응답이 오면 onInventoryUpdate 가 applyRefresh() 를 부른다.
 */
function requestRefresh() {
  log.info('refresh', '요청', { 연결: ws.isConnected(), 캐시있음: !!inventory });

  if (pendingRefresh) {
    log.info('refresh', '이미 진행 중 — 무시');
    return;
  }

  const sent = ws.send({ type: 'refresh' });

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
  renderStatus();

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
    }, 3000),
  };
}

function setRefreshError(msg) {
  refreshState = 'error';
  refreshErrorMsg = msg;
  renderStatus();
}

/** 최신 인벤토리를 격자에 반영하고, 발동 중인 콤보를 우선순위 기본값으로 채운다. */
function applyRefresh() {
  if (!inventory) { log.warn('refresh', 'applyRefresh 호출됐지만 인벤토리 없음'); return; }

  displayed = inventory;
  displayedKind = 'current';
  refreshState = 'idle';

  applyActiveCombosAsPriority();
  renderPriority();
  renderGrid();
  renderStatus();

  log.info('refresh', '격자 갱신', {
    아이템: (inventory.items || []).length,
    우선순위: priority.join(',') || '(없음)',
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

function requestOptimize() {
  // 계산 중에 다시 누르면 이전 요청을 버리고 처음부터 다시 시작한다
  calcSeq++;
  log.info('optimize', '요청', { seq: calcSeq, mode: enhanceMode, priority: priority.join(',') || '(없음)' });

  const sent = ws.send({
    type: 'optimize',
    seq: calcSeq,
    priority: priority,
    mode: enhanceMode,
  });

  if (!sent) {
    optimizeState = 'error';
    renderStatus();
    return;
  }

  optimizeState = 'calculating';
  renderStatus();
}

/**
 * 계산된 배치를 게임 인벤토리에 반영한다.
 * 플러그인은 게임 자체의 네트워크 안전 API(Swap/DoClickAction)로만 이동·회전한다.
 */
function requestApply() {
  if (!lastSearch || displayedKind !== 'optimized') {
    log.warn('apply', '반영할 계산 결과가 없음');
    return;
  }
  if (applyState === 'applying') return;

  const { ctx, placement, rotations } = lastSearch;
  const moves = ctx.items.map((it, i) => ({
    iid: it.iid,
    idx: placement[i],
    rot: it.kind === 'tablet' ? rotations[i] : 0,
  }));

  applySeq++;
  log.info('apply', '요청', { seq: applySeq, 아이템: moves.length });

  const sent = ws.send({ type: 'apply', seq: applySeq, moves });
  if (!sent) {
    applyState = 'error';
    applyErrorMsg = '게임에 연결되지 않았습니다';
    renderStatus();
    return;
  }

  applyState = 'applying';
  renderStatus();

  applyTimer = setTimeout(() => {
    applyTimer = null;
    applyState = 'error';
    applyErrorMsg = '응답이 없습니다 (게임 재시작 후 새 플러그인 필요할 수 있음)';
    log.error('apply', '타임아웃');
    renderStatus();
  }, 8000);
}

// ── 렌더 ──────────────────────────────────────────────

function renderGrid() {
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

function renderStatus() {
  const badge = document.getElementById('opt-badge');
  const note = document.getElementById('opt-stale-note');
  const btn = document.getElementById('btn-calc');
  const refreshBtn = document.getElementById('btn-refresh');
  const applyBtn = document.getElementById('btn-apply');

  const CALC_LABEL = '▶ 계산 <small>(Ctrl+R)</small>';

  // 반영 버튼은 '계산 결과를 보고 있는 상태' 에서만 보인다
  const canApply = optimizeState === 'done' && lastSearch && displayedKind === 'optimized';
  applyBtn.classList.toggle('hidden', !(canApply || applyState === 'applying'));
  if (applyState === 'applying') {
    applyBtn.innerHTML = '<span class="spinner"></span> 반영 중';
    applyBtn.disabled = true;
  } else {
    applyBtn.innerHTML = '✔ 반영';
    applyBtn.disabled = false;
  }

  if (applyState === 'error') {
    badge.className = 'status-badge error';
    badge.textContent = applyErrorMsg || '반영 실패';
    note.classList.add('hidden');
    return;
  }

  badge.className = 'status-badge';
  note.classList.add('hidden');
  btn.disabled = false;   // 계산 중에도 다시 누를 수 있어야 한다

  // 새로고침도 계산과 같은 로딩 UI 를 쓴다
  if (refreshState === 'loading') {
    refreshBtn.innerHTML = '<span class="spinner"></span> 불러오는 중';
    refreshBtn.disabled = true;
  } else {
    refreshBtn.innerHTML = '⟳ 새로고침';
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
    btn.innerHTML = '↻ 다시 계산';
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

// ── 콤보 우선순위 UI ──────────────────────────────────

function renderPriority() {
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
      renderPriority();
    });

    row.addEventListener('dragstart', () => row.classList.add('dragging'));
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      priority = [...list.querySelectorAll('.prio-row')].map(r => r.dataset.id);
      renderPriority();
    });

    list.appendChild(row);
  });

  // 같은 함수 참조라 중복 등록되지 않는다
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

  combos()
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
        renderPriority();
      });
      picker.appendChild(el);
    });
}

module.exports = { init, requestOptimize, currentInventory };
