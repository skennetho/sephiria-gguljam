// 최적 배치 패널 (Ctrl+D).
//
// 상태 흐름이 셋 겹쳐 있다. 우선순위는 renderStatus() 의 분기 순서가 정의한다:
//  - refresh:  새로고침 (다음 inventory_update 를 기다리는 비동기 동작)
//  - optimize: 계산 (플러그인에 스냅샷 요청 -> 엔진 탐색)
//  - apply:    반영 (계산 결과를 게임 인벤토리에 전송)
//
// 격자에는 두 가지 보기 모드가 있다 (view-seg 토글):
//  - current   : 게임 인벤토리를 실시간으로 따라간다 (플러그인이 500ms 마다 방송)
//  - optimized : 계산 결과를 고정해서 보여준다. 배치를 따라하는 동안
//                화면이 바뀌면 안 되므로 인벤토리 변화를 반영하지 않는다.
// 계산이 끝나면 optimized 로 전환되고, 사용자가 언제든 토글로 되돌아올 수 있다.

'use strict';

const engine = require('../optimizer');
const { log, guard, formatAgo, esc } = require('./util');
const { itemById, comboById, combos, comboName, comboIcon, renderComboBadge, ASSETS, RARITY_RANK } = require('./gamedata');
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
let lastOptimizedLayout = null; // 계산 결과 격자 스냅샷 (보기 모드 토글용)
let applyState = 'idle';     // idle | applying | error
let applySeq = 0;
let applyTimer = null;
let applyErrorMsg = '';

let undoState = null;        // { moves, items, appliedAt } — 직전 반영을 되돌리기 위한 스냅샷
let pendingUndoMoves = null; // 반영 요청 시점에 기록하는 직전 배치
let pendingUndoItems = null; // 반영 요청 시점의 iid 목록
let pendingApplyAction = 'apply'; // 'apply' | 'undo'

let pendingRefresh = null;   // { timer, isPostActionSync }
let refreshState = 'idle';   // idle | loading | error
let refreshErrorMsg = '';

// 실시간 모드에서 500ms 마다 DOM 을 새로 만들 필요는 없다.
// 배치가 실제로 달라졌을 때만 다시 그린다.
let lastGridSignature = '';

let priority = [];           // 콤보 우선순위 (id 배열)
let enhanceMode = 'combo';   // combo | even

/**
 * inventory_update 의 items 중 '격자에 놓인 것' 만 추린다.
 *
 * 인벤토리 스냅샷에는 포션 벨트(y = 100) 처럼 격자 밖 슬롯도 섞여 있다.
 * 최적화 스냅샷(optimize_data)은 격자만 담으므로, 둘을 비교할 때는
 * 반드시 같은 기준으로 맞춰야 한다. (되돌리기가 즉시 풀리던 원인)
 */
function gridItemsOf(snap) {
  if (!snap || !snap.items) return [];
  const w = snap.width || 6;
  const storage = snap.storage || (w * (snap.height || 6));
  return snap.items.filter(it =>
    it.x >= 0 && it.x < w && it.y >= 0 && (it.y * w + it.x) < storage);
}

/** 되돌리기(Undo) 상태를 엄격하게 무효화한다 */
function invalidateUndo(reason) {
  if (undoState) {
    undoState = null;
    log.info('undo', '되돌리기 비활성화 (' + (reason || '상태 변경') + ')');
    renderStatus();
  }
}

/** 다른 모듈이 최신 인벤토리를 읽을 때 (빌드 패널의 보유 표시 등) */
function currentInventory() {
  return inventory;
}

// ── 초기화 ────────────────────────────────────────────

function init() {
  renderPriority();
  renderGrid();
  renderViewToggle();

  ws.on('inventory_update', onInventoryUpdate);
  ws.on('optimize_data', onOptimizeData);
  ws.on('optimize_error', onOptimizeError);
  ws.on('apply_result', onApplyResult);

  document.getElementById('btn-calc')
    .addEventListener('click', guard('btn:calc', () => {
      invalidateUndo('새 계산 클릭');
      requestOptimize();
    }));

  // 주의: 이 바인딩이 이전 리팩터링에서 유실된 적이 있다 (새로고침 버튼 무반응).
  document.getElementById('btn-refresh')
    .addEventListener('click', guard('btn:refresh', () => {
      invalidateUndo('새로고침 클릭');
      requestRefresh();
    }));

  document.getElementById('btn-apply')
    .addEventListener('click', guard('btn:apply', requestApply));

  document.getElementById('btn-undo')
    .addEventListener('click', guard('btn:undo', requestUndo));

  document.getElementById('view-seg').addEventListener('click', guard('view', e => {
    const el = e.target.closest('div[data-view]');
    if (!el || el.classList.contains('disabled')) return;
    setViewMode(el.dataset.view);
  }));

  document.getElementById('btn-add-combo').addEventListener('click', () => {
    invalidateUndo('콤보 추가 클릭');
    const picker = document.getElementById('combo-picker');
    picker.classList.toggle('hidden');
    if (!picker.classList.contains('hidden')) renderComboPicker();
  });

  document.querySelectorAll('#mode-seg div').forEach(seg => {
    seg.addEventListener('click', () => {
      invalidateUndo('강화 모드 변경');
      document.querySelectorAll('#mode-seg div').forEach(s => s.classList.remove('on'));
      seg.classList.add('on');
      enhanceMode = seg.dataset.mode;
    });
  });

  // 상태 배지의 '몇 분 전' 을 갱신
  setInterval(() => { if (optimizeState === 'done') renderStatus(); }, 30000);

  // 다국어 변경 시 즉시 갱신
  const i18n = require('./i18n');
  i18n.onLanguageChange(() => {
    lastGridSignature = '';
    renderPriority();
    renderGrid();
    renderStatus();
  });
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

  // 되돌리기(Undo) 유효성 검사: 격자 아이템 구성이 달라졌다면 무효화한다.
  // 격자 밖 슬롯(포션 벨트 등)은 최적화 대상이 아니므로 비교에서 뺀다 —
  // 예전엔 전체 items 와 비교해서 반영 직후 항상 풀렸다.
  if (undoState && data && data.items) {
    const curIids = new Set(gridItemsOf(data).map(it => it.instanceID || it.iid));
    const match = undoState.items.length === curIids.size &&
      undoState.items.every(id => curIids.has(id));
    if (!match) {
      invalidateUndo('격자 아이템 구성 변경 감지');
    }
  }

  // 새로고침을 기다리고 있었다면 지금 완료시킨다
  if (pendingRefresh) {
    clearTimeout(pendingRefresh.timer);
    pendingRefresh = null;
    applyRefresh();
    log.info('refresh', '완료 (서버 응답 수신)');
    return;
  }

  if (first && displayedKind === 'none') {
    // 최초 1회는 자동으로 채워준다
    applyRefresh();
    return;
  }

  // 실시간 모드: 게임에서 아이템을 옮기면 곧바로 격자에 반영된다.
  // 계산 결과를 보는 중(optimized)이면 건드리지 않는다.
  if (displayedKind === 'current') {
    displayed = inventory;
    renderGrid();
    renderViewToggle();
  }
}

function onOptimizeData(data) {
  // 재시작된 계산이라면 옛 스냅샷은 버린다
  if (data && data.seq != null && data.seq !== calcSeq) {
    log.info('optimize', '옛 스냅샷 무시', { 받음: data.seq, 현재: calcSeq });
    return;
  }
  invalidateUndo('새 최적화 데이터 수신');
  // 비동기 틱으로 분리하여 UI 렌더러가 프레임 드랍 없이 반응하도록 보장
  setTimeout(() => {
    runSearch(data);
  }, 0);
}

function onOptimizeError(data) {
  if (data && data.seq != null && data.seq !== calcSeq) return;
  optimizeState = 'error';
  optimizeErrorMsg = (data && data.message) || '계산 실패';
  invalidateUndo('최적화 오류');
  log.error('optimize', '플러그인 오류', optimizeErrorMsg);
  renderStatus();
}

function onApplyResult(data) {
  if (data && data.seq != null && data.seq !== applySeq) return;
  if (applyTimer) { clearTimeout(applyTimer); applyTimer = null; }

  if (data && data.ok) {
    if (pendingApplyAction === 'apply' && pendingUndoMoves) {
      undoState = {
        moves: pendingUndoMoves,
        items: pendingUndoItems,
        appliedAt: Date.now(),
      };
      log.info('apply', '반영 완료 — 되돌리기(Undo) 활성화', { 스왑: data.swaps, 회전: data.rotations });
    } else if (pendingApplyAction === 'undo') {
      undoState = null;
      log.info('undo', '되돌리기 완료', { 스왑: data.swaps, 회전: data.rotations });
    }
    pendingUndoMoves = null;
    pendingUndoItems = null;
    applyState = 'idle';
    // 반영 결과를 현재 배치로 다시 읽어와 확인시켜 준다
    requestRefresh();
  } else {
    applyState = 'error';
    applyErrorMsg = (data && data.message) || (pendingApplyAction === 'undo' ? '되돌리기 실패' : '반영 실패');
    undoState = null;
    pendingUndoMoves = null;
    pendingUndoItems = null;
    log.error('apply', '작업 실패', applyErrorMsg);
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
    lastGridSignature = '';   // 모드가 바뀌었으니 다음 렌더를 강제한다
    lastSearch = { ctx, placement: best.placement, rotations: best.rotations };
    lastOptimizedLayout = displayed;
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
  lastGridSignature = '';   // 모드 전환 직후엔 반드시 다시 그린다

  applyActiveCombosAsPriority();
  renderPriority();
  renderGrid();
  renderViewToggle();
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

  // 직전 인벤토리 배치를 되돌리기(Undo)용으로 백업
  pendingUndoMoves = ctx.items.map(it => ({
    iid: it.iid,
    idx: it.homeIdx,
    rot: it.kind === 'tablet' ? it.rot : 0,
  }));
  pendingUndoItems = ctx.items.map(it => it.iid);
  pendingApplyAction = 'apply';

  applySeq++;
  log.info('apply', '요청', { seq: applySeq, 아이템: moves.length });

  const sent = ws.send({ type: 'apply', seq: applySeq, moves });
  if (!sent) {
    applyState = 'error';
    applyErrorMsg = '게임에 연결되지 않았습니다';
    pendingUndoMoves = null;
    pendingUndoItems = null;
    renderStatus();
    return;
  }

  applyState = 'applying';
  renderStatus();

  applyTimer = setTimeout(() => {
    applyTimer = null;
    applyState = 'error';
    applyErrorMsg = '응답이 없습니다 (게임 재시작 후 새 플러그인 필요할 수 있음)';
    pendingUndoMoves = null;
    pendingUndoItems = null;
    log.error('apply', '타임아웃');
    renderStatus();
  }, 8000);
}

/**
 * 직전 반영된 배치를 취소하고 이전 인벤토리 상태로 원복한다.
 * 반영 직후에만 활성화되며, 1회 수행 후 즉시 소모된다.
 */
function requestUndo() {
  if (!undoState || applyState === 'applying') {
    log.warn('undo', '되돌릴 수 있는 상태가 아님');
    return;
  }

  const moves = undoState.moves;
  if (!moves || moves.length === 0) return;

  // 되돌리기 상태 1회용 즉시 소모
  undoState = null;
  pendingUndoMoves = null;
  pendingUndoItems = null;
  pendingApplyAction = 'undo';

  applySeq++;
  log.info('undo', '되돌리기 요청', { seq: applySeq, 아이템: moves.length });

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
    applyErrorMsg = '응답이 없습니다';
    log.error('undo', '타임아웃');
    renderStatus();
  }, 8000);
}

// ── 렌더 ──────────────────────────────────────────────

function renderGrid() {
  const grid = document.getElementById('opt-grid');
  const caption = document.getElementById('grid-caption');
  const i18n = require('./i18n');

  if (!displayed) {
    grid.style.gridTemplateColumns = '';
    grid.innerHTML = `<div class="empty">${i18n.t('opt.empty')}</div>`;
    caption.textContent = i18n.t('opt.empty');
    lastGridSignature = '';
    return;
  }

  if (displayedKind === 'optimized') {
    caption.textContent = i18n.t('opt.captionOptimized');
  } else {
    caption.innerHTML = `<span class="live-dot"></span>${i18n.t('opt.captionCurrent')}`;
  }

  // 같은 배치를 500ms 마다 다시 그리지 않는다
  const sig = gridSignature(displayed, displayedKind);
  if (sig === lastGridSignature) return;
  lastGridSignature = sig;

  renderGridInto(grid, displayed);
}

/** 격자 렌더 결과를 좌우하는 값만 모은 지문 */
function gridSignature(snap, kind) {
  const parts = [kind, snap.width, snap.storage];
  for (const it of (snap.items || [])) {
    parts.push(`${it.instanceID}:${it.x},${it.y}:${it.level}:${it.isActive ? 1 : 0}`);
  }
  return parts.join('|');
}

/** 보기 모드 토글의 활성/비활성 상태를 화면에 반영한다 */
function renderViewToggle() {
  const seg = document.getElementById('view-seg');
  if (!seg) return;

  const hasResult = !!lastSearch;
  for (const el of seg.querySelectorAll('div')) {
    const view = el.dataset.view;
    el.classList.toggle('on', view === displayedKind);
    // 계산 결과가 없으면 '계산 결과' 탭은 고를 수 없다
    el.classList.toggle('disabled', view === 'optimized' && !hasResult);
  }
}

/** 사용자가 보기 모드를 직접 바꿀 때 */
function setViewMode(mode) {
  if (mode === displayedKind) return;

  if (mode === 'optimized') {
    if (!lastSearch || !lastOptimizedLayout) return;
    displayed = lastOptimizedLayout;
    displayedKind = 'optimized';
  } else {
    if (!inventory) return;
    displayed = inventory;
    displayedKind = 'current';
  }

  lastGridSignature = '';
  log.info('view', '보기 모드 전환', mode);
  renderGrid();
  renderViewToggle();
  renderStatus();
}

function renderStatus() {
  const badge = document.getElementById('opt-badge');
  const note = document.getElementById('opt-stale-note');
  const btn = document.getElementById('btn-calc');
  const refreshBtn = document.getElementById('btn-refresh');
  const applyBtn = document.getElementById('btn-apply');
  const undoBtn = document.getElementById('btn-undo');

  const CALC_LABEL = '▶ 계산 <small>(Ctrl+R)</small>';

  // 반영 버튼은 '계산 결과를 보고 있는 상태' 에서만 보인다
  const canApply = optimizeState === 'done' && lastSearch && displayedKind === 'optimized';
  applyBtn.classList.toggle('hidden', !(canApply || (applyState === 'applying' && pendingApplyAction === 'apply')));
  if (applyState === 'applying' && pendingApplyAction === 'apply') {
    applyBtn.innerHTML = '<span class="spinner"></span> 반영 중';
    applyBtn.disabled = true;
  } else {
    applyBtn.innerHTML = '✔ 반영';
    applyBtn.disabled = false;
  }

  // 되돌리기 버튼: 직전 반영 성공 시에만 활성화 (엄격한 조건)
  if (undoBtn) {
    const canUndo = undoState !== null && applyState !== 'applying';
    undoBtn.disabled = !canUndo;
    if (applyState === 'applying' && pendingApplyAction === 'undo') {
      undoBtn.innerHTML = '<span class="spinner"></span> 되돌리는 중';
    } else {
      undoBtn.innerHTML = '⤺ 되돌리기';
    }
  }

  if (applyState === 'error') {
    badge.className = 'status-badge error';
    badge.textContent = applyErrorMsg || '작업 실패';
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
    const row = document.createElement('div');
    row.className = 'prio-row';
    row.draggable = true;
    row.dataset.id = id;
    row.innerHTML =
      `<span class="handle">≡</span><span class="rank">${idx + 1}</span>` +
      `<img src="${comboIcon(id)}" onerror="this.style.visibility='hidden'">` +
      `<span>${esc(comboName(id))}</span><span class="x">✕</span>`;

    row.querySelector('.x').addEventListener('click', e => {
      e.stopPropagation();
      invalidateUndo('콤보 우선순위 삭제');
      priority = priority.filter(p => p !== id);
      renderPriority();
    });

    row.addEventListener('dragstart', () => row.classList.add('dragging'));
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      invalidateUndo('콤보 우선순위 드래그 변경');
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
        `<img src="${comboIcon(c.id)}" onerror="this.style.visibility='hidden'">` +
        `<span>${esc(comboName(c.id))}</span>`;
      el.addEventListener('click', () => {
        invalidateUndo('콤보 우선순위 추가');
        priority.push(c.id);
        picker.classList.add('hidden');
        renderPriority();
      });
      picker.appendChild(el);
    });
}

module.exports = { init, requestOptimize, currentInventory };
