// 배치 최적화 엔진 (오버레이 측)
//
// 플러그인이 넘겨준 optimize_data 스냅샷만 가지고 순수 계산을 한다.
// 게임을 건드리지 않으며, 게임 없이도 단위 테스트가 가능하다.
//
// ── 게임 규칙 요약 (디컴파일로 확인한 것) ───────────────────────────
//
// 격자: idx = y * width + x. 유효한 칸은 0 <= idx < storage.
//       height = ceil(storage / width) 라 마지막 줄은 부분적으로만 존재한다.
//
// 레벨: level(칸) = (기본 + 석판 IncreaseConstLevel 합) * (MultiplyConstLevel 합, 0이면 1)
//       기본 = 그 칸의 dungeonTempLevels + 그 칸에 놓인 아이템의 인챈트
//       MUL 은 '곱하기'가 아니라 '더해서 한 번 곱한다'. MUL/3 두 개면 x6 이지 x9 가 아니다.
//       maxLevel 은 효과 계산에만 걸리고 발동 여부에는 영향이 없다.
//
// 발동: 참이 발동하려면
//         비활성화 아님(disable) && level >= 0 && (조건무시 || 조건 만족)
//
// 석판: 자기 발동조건(conditionQuery)을 만족해야 효과를 낸다. 부분 효과는 없다.
//       ITEM/CHARM 조건은 전부(AND) 만족해야 하고, PLACED 조건은 하나만(OR) 맞으면 된다.
//
// ────────────────────────────────────────────────────────────────

'use strict';

// 효과 코드 (플러그인과 맞춰야 한다)
const OP_INCREASE = 1;
const OP_DISABLE = 2;
const OP_IGNORE = 3;
const OP_MULTIPLY = 4;

const CRIT_ANY_ITEM = 1;
const CRIT_ONLY_CHARM = 2;
const CRIT_PLACED = 3;

/**
 * 스냅샷을 탐색하기 좋은 형태로 정리한다.
 * @param {object} snap 플러그인이 보낸 optimize_data.data
 */
function prepare(snap) {
  const width = snap.width;
  const storage = snap.storage;
  const height = Math.ceil(storage / width);

  const items = snap.items.map((it, i) => ({
    i,
    iid: it.iid,
    eid: it.eid,
    name: it.name,
    kind: it.kind,
    isCharmType: !!it.charmType,
    isMagic: !!it.magic,
    maxLevel: it.maxLevel != null ? it.maxLevel : 0,
    enchant: it.enchant || 0,
    criteria: it.criteria || null,
    homeIdx: it.idx,
    rot: it.rot || 0,
    rotatable: !!it.rotatable,
    pat: it.pat != null ? it.pat : -1,
  }));

  return {
    width, storage, height,
    cellBase: snap.cellBase || new Array(storage).fill(0),
    fullHp: !!snap.fullHp,
    items,
    patterns: snap.patterns || [],
    engravings: snap.engravings || [],
  };
}

/**
 * 배치(placement: 아이템 인덱스 -> 칸 idx)에 대해 각 칸의 최종 레벨과 발동 여부를 계산한다.
 *
 * @param {object} ctx prepare() 결과
 * @param {Int32Array} placement placement[itemIndex] = 칸 idx
 * @param {Int32Array} rotations rotations[itemIndex] = 회전 0..3 (석판만 의미 있음)
 * @returns {{level: Int32Array, active: Uint8Array, occupant: Int32Array}}
 */
function evaluate(ctx, placement, rotations) {
  const { width, storage, items, patterns, engravings, cellBase } = ctx;

  // 칸 -> 아이템 인덱스
  const occupant = new Int32Array(storage).fill(-1);
  for (let i = 0; i < items.length; i++) {
    const idx = placement[i];
    if (idx >= 0 && idx < storage) occupant[idx] = i;
  }

  // 1) 기본 레벨 = 칸 고정분 + 그 칸에 놓인 아이템의 인챈트
  const add = new Int32Array(storage);
  const mul = new Int32Array(storage);
  const disable = new Int32Array(storage);
  const ignore = new Int32Array(storage);

  for (let c = 0; c < storage; c++) add[c] = cellBase[c] || 0;
  for (let i = 0; i < items.length; i++) {
    const idx = placement[i];
    if (idx >= 0 && idx < storage) add[idx] += items[i].enchant;
  }

  // 2) 석판 효과 적용 (발동조건을 만족하는 석판만)
  //    석판의 발동조건은 '아이템이 어디 있는지'만 보므로 서로 영향을 주지 않는다.
  //    따라서 한 번의 패스로 끝난다.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'tablet' || it.pat < 0) continue;

    const cell = placement[i];
    if (cell < 0 || cell >= storage) continue;

    const pat = patterns[it.pat];
    if (!pat) continue;

    const rotMap = pat.rots[String(rotations[i])] || pat.rots[String(it.rot)];
    if (!rotMap) continue;

    const entry = rotMap[String(cell)];
    if (!entry) continue;

    if (!tabletActive(entry, cell, occupant, items)) continue;

    applyEffects(entry.e, add, mul, disable, ignore);
  }

  // 3) 각인은 움직이지 않지만 조건은 후보 배치에 따라 달라진다
  for (const eng of engravings) {
    const rotKeys = Object.keys(eng.rots);
    if (rotKeys.length === 0) continue;
    const rotMap = eng.rots[rotKeys[0]];
    const originKeys = Object.keys(rotMap);
    if (originKeys.length === 0) continue;
    const cell = parseInt(originKeys[0], 10);
    const entry = rotMap[originKeys[0]];

    if (!tabletActive(entry, cell, occupant, items)) continue;
    applyEffects(entry.e, add, mul, disable, ignore);
  }

  // 4) 곱셈은 마지막에 '칸 합계'에 한 번만 적용된다
  const level = new Int32Array(storage);
  for (let c = 0; c < storage; c++) {
    const m = mul[c];
    level[c] = m === 0 ? add[c] : add[c] * m;
  }

  // 5) 참 발동 판정
  const active = new Uint8Array(storage);
  for (let c = 0; c < storage; c++) {
    const i = occupant[c];
    if (i < 0) continue;
    const it = items[i];
    if (it.kind !== 'charm') continue;

    if (disable[c] > 0) continue;
    if (level[c] < 0) continue;
    if (ignore[c] === 0 && !criteriaMet(ctx, it, c, occupant, items)) continue;

    active[c] = 1;
  }

  return { level, active, occupant };
}

function applyEffects(effects, add, mul, disable, ignore) {
  for (const [idx, op, param] of effects) {
    switch (op) {
      case OP_INCREASE: add[idx] += param; break;
      case OP_MULTIPLY: mul[idx] += param; break;   // 합산 후 한 번만 곱한다
      case OP_DISABLE: disable[idx] += 1; break;
      case OP_IGNORE: ignore[idx] += 1; break;
    }
  }
}

/**
 * 석판이 발동하는가.
 * ITEM/CHARM 조건은 모두 만족해야 하고(AND),
 * PLACED 조건이 하나라도 있으면 그중 하나가 석판 자기 칸과 일치해야 한다(OR).
 */
function tabletActive(entry, ownCell, occupant, items) {
  const crits = entry.c;
  if (!crits || crits.length === 0) return true;

  let allMet = true;
  let hasPlaced = false;
  let placedHit = false;

  for (const [idx, op] of crits) {
    if (op === CRIT_PLACED) {
      hasPlaced = true;
      if (idx === ownCell) placedHit = true;
      continue;
    }

    // 격자 밖(-1)은 영원히 비어 있으므로 '아이템 있음' 조건을 만족할 수 없다
    const occ = idx >= 0 ? occupant[idx] : -1;
    if (occ < 0) { allMet = false; continue; }

    if (op === CRIT_ONLY_CHARM && items[occ].kind !== 'charm') allMet = false;
  }

  if (!allMet) return false;
  if (hasPlaced && !placedHit) return false;
  return true;
}

// ── 참 발동조건 10종 ────────────────────────────────────────────
//
// 게임 코드를 그대로 옮긴 것이다. 특히 아래 세 개는 흔히 틀리는 부분이라 주의:
//  - BottomInInventory 는 '마지막 줄'이 아니라 '마지막 6칸'(선형 인덱스 기준)
//  - Inside 의 아래쪽 경계도 선형 인덱스 기준 (idx <= storage - 8)
//  - Outlined 는 Inside 의 여집합이 아니다. 둘 다 아닌 칸이 존재한다.

function criteriaMet(ctx, item, cell, occupant, items) {
  const { width, storage, height, fullHp } = ctx;
  const x = cell % width;
  const y = (cell / width) | 0;

  switch (item.criteria) {
    case null:
    case undefined:
      return true;

    case 'CharmActivateCriteria_TopInInventory':
      return y === 0;

    case 'CharmActivateCriteria_BottomInInventory':
      return cell >= storage - 6;

    case 'CharmActivateCriteria_Inside':
      return x > 0 && y > 0 && x < width - 1 && cell <= storage - 8;

    case 'CharmActivateCriteria_Outlined':
      return x === 0 || y === 0 || x >= width - 1 || cell >= storage - 6;

    case 'CharmActivateCriteria_SideEnd':
      // 게임은 5를 상수로 박아두었다 (Width 는 항상 6)
      return x === 0 || x === 5;

    case 'CharmActivateCriteria_BothSideCharm': {
      if (x <= 0 || x >= width - 1) return false;
      const l = occupant[cell - 1], r = occupant[cell + 1];
      if (l < 0 || r < 0) return false;
      // 이웃이 'Charm 타입'이어야 한다. 석판 이웃은 만족시키지 못한다.
      return items[l].isCharmType && items[r].isCharmType;
    }

    case 'CharmActivateCriteria_BothSidesAreEmpty': {
      if (x <= 0 || x >= width - 1) return false;
      const rem = storage % width;
      // 부분 행에서는 오른쪽 이웃 칸이 아예 없을 수 있다
      if (!(rem === 0 || y < height - 1 || x < rem - 1)) return false;
      return occupant[cell - 1] < 0 && occupant[cell + 1] < 0;
    }

    case 'CharmActivateCriteria_NeighborsAreFull':
      // 4방향이 아니라 8방향이다. 가장자리에서는 절대 만족할 수 없다.
      return neighbors8(ctx, cell).every(n => n >= 0 && occupant[n] >= 0);

    case 'CharmActivateCriteria_Near8MagicBook':
      return neighbors8(ctx, cell).some(n => {
        if (n < 0) return false;
        const o = occupant[n];
        return o >= 0 && items[o].isMagic;
      });

    case 'CharmActivateCriteria_FullHP':
      // 배치와 무관하다. 고정 입력으로만 쓴다.
      return fullHp;

    default:
      // 모르는 조건은 '항상 만족'으로 두지 않는다. 그래야 점수를 부풀리지 않는다.
      return false;
  }
}

const DIR8 = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];

/** 8방향 이웃 칸. 격자 밖이면 -1. */
function neighbors8(ctx, cell) {
  const { width, storage } = ctx;
  const x = cell % width;
  const y = (cell / width) | 0;
  const out = [];
  for (const [dx, dy] of DIR8) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0) { out.push(-1); continue; }
    const n = ny * width + nx;
    out.push(n >= 0 && n < storage ? n : -1);
  }
  return out;
}

// ── 목적함수 ────────────────────────────────────────────────────

/**
 * 배치 점수.
 *
 * 콤보 단계는 '보유 개수'로 정해지므로 배치로 바꿀 수 없다.
 * 배치가 바꾸는 것은 각 아티팩트의 최종 강화수뿐이다. 따라서
 *  - combo 모드: 우선순위 콤보에 속한 아티팩트의 강화수를 순위 가중치로 최대화
 *  - even  모드: 강화수를 고르게 (가장 낮은 것을 끌어올린다)
 *
 * 두 모드 모두 '발동하지 않는 참'에는 큰 감점을 준다. 발동하지 않으면 강화수가 의미 없다.
 */
function score(ctx, evalResult, opts) {
  const { level, active, occupant } = evalResult;
  const { items, storage } = ctx;
  const mode = opts.mode || 'combo';
  const weightOf = opts.weightOf || (() => 1);
  const tieOf = opts.tieOf || (() => ({ combo: 0, rarity: 0 }));

  // 주 목적(강화수)과 타이브레이크를 한 스칼라에 담기 위해 자릿수를 분리한다.
  // P 가 충분히 커야 타이브레이크 합이 강화수 1 차이를 절대 뒤집지 못한다.
  // (아이템 ~30개 × eff ≤ 20 × 타이 ≤ 14 = 8,400 << P)
  const P = 100000;

  let total = 0;
  let inactiveCharms = 0;
  const effLevels = [];

  for (let c = 0; c < storage; c++) {
    const i = occupant[c];
    if (i < 0) continue;
    const it = items[i];
    if (it.kind !== 'charm') continue;

    if (!active[c]) { inactiveCharms++; continue; }

    // 상한을 넘은 레벨은 효과에 반영되지 않는다
    const eff = Math.max(0, Math.min(level[c], it.maxLevel));
    effLevels.push(eff);

    if (mode === 'combo') {
      total += eff * weightOf(it) * P;
    } else {
      total += eff * P;
    }

    // 타이브레이크: 강화 총합이 같다면 콤보 소속 아티팩트에게 강화를 몰아주고,
    // 그것도 같다면 희귀도 높은 쪽을 우선한다. (콤보 10 > 희귀도 최대 4)
    const tie = tieOf(it);
    total += eff * ((tie.combo ? 10 : 0) + (tie.rarity || 0));
  }

  // 발동 실패는 강하게 벌점 (게임 자체 점수함수도 비활성에 큰 감점을 준다)
  total -= inactiveCharms * 50 * P;

  if (mode === 'even' && effLevels.length > 0) {
    // 최소값을 끌어올리는 쪽을 선호한다 (분산이 아니라 최소값 기준이 직관적이다)
    const min = Math.min(...effLevels);
    const avg = effLevels.reduce((a, b) => a + b, 0) / effLevels.length;
    total += (min * 10 - (avg - min) * 2) * P;
  }

  return total;
}

/**
 * 우선순위 콤보 가중치 함수를 만든다.
 * 1순위가 가장 크고, 목록에 없는 콤보는 1.
 */
function makeWeightFn(priority, categoriesOf) {
  const rank = new Map();
  priority.forEach((id, i) => rank.set(id, priority.length - i));

  return item => {
    const cats = categoriesOf(item) || [];
    let best = 0;
    for (const c of cats) {
      const r = rank.get(c);
      if (r != null && r > best) best = r;
    }
    return best > 0 ? 1 + best * 2 : 1;
  };
}

// ── 탐색 ────────────────────────────────────────────────────────

/**
 * 담금질(simulated annealing)로 배치를 찾는다.
 *
 * 탐색 공간은 '아이템을 칸에 배정하는 순열'이다. 빈 칸도 후보에 포함해야
 * 아이템이 빈 자리로 옮겨갈 수 있다. 석판은 회전도 함께 바꾼다.
 *
 * @param {object} ctx prepare() 결과
 * @param {object} opts { mode, weightOf, iterations, onProgress, shouldStop }
 */
function optimize(ctx, opts = {}) {
  const { items, storage } = ctx;
  const iterations = opts.iterations || 20000;
  const rand = opts.random || Math.random;

  // 현재 배치에서 시작
  let placement = new Int32Array(items.length);
  let rotations = new Int32Array(items.length);
  for (let i = 0; i < items.length; i++) {
    placement[i] = items[i].homeIdx;
    rotations[i] = items[i].rot;
  }

  const startScore = score(ctx, evaluate(ctx, placement, rotations), opts);

  let best = { placement: placement.slice(), rotations: rotations.slice(), score: startScore };
  let cur = { placement, rotations, score: startScore };

  // 이동 가능한 아이템만 섞는다
  const movable = items.map((_, i) => i);
  const rotatables = items
    .map((it, i) => (it.kind === 'tablet' && it.rotatable ? i : -1))
    .filter(i => i >= 0);

  let temp = 120;
  const cooling = Math.pow(0.02 / temp, 1 / iterations);

  for (let iter = 0; iter < iterations; iter++) {
    if (opts.shouldStop && (iter & 0x3ff) === 0 && opts.shouldStop()) break;
    if (opts.onProgress && (iter & 0x7ff) === 0) opts.onProgress(iter / iterations);

    const nextPlacement = cur.placement.slice();
    const nextRotations = cur.rotations.slice();

    if (rotatables.length > 0 && rand() < 0.25) {
      // 회전 변경
      const i = rotatables[(rand() * rotatables.length) | 0];
      nextRotations[i] = ((rand() * 4) | 0);
    } else {
      // 두 칸을 맞바꾼다. 한쪽이 비어 있으면 '이동'이 된다.
      const i = movable[(rand() * movable.length) | 0];
      const target = (rand() * storage) | 0;

      const j = nextPlacement.indexOf(target);
      const from = nextPlacement[i];
      nextPlacement[i] = target;
      if (j >= 0 && j !== i) nextPlacement[j] = from;
    }

    const s = score(ctx, evaluate(ctx, nextPlacement, nextRotations), opts);
    const delta = s - cur.score;

    if (delta > 0 || Math.exp(delta / temp) > rand()) {
      cur = { placement: nextPlacement, rotations: nextRotations, score: s };
      if (s > best.score) {
        best = { placement: nextPlacement.slice(), rotations: nextRotations.slice(), score: s };
      }
    }

    temp *= cooling;
  }

  return {
    startScore,
    bestScore: best.score,
    placement: best.placement,
    rotations: best.rotations,
    evaluation: evaluate(ctx, best.placement, best.rotations),
  };
}

module.exports = {
  prepare, evaluate, score, optimize, makeWeightFn, criteriaMet, neighbors8,
  OP_INCREASE, OP_DISABLE, OP_IGNORE, OP_MULTIPLY,
};
