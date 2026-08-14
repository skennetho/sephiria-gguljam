// optimizer.js 단위 테스트. 게임 없이 돌아간다.
//   node overlay/optimizer.test.js
//
// 여기서 검증하는 것은 '게임 규칙을 정확히 옮겼는가'다.
// 특히 예전 구현이 틀렸던 지점들을 회귀 테스트로 박아둔다.

'use strict';

const opt = require('./optimizer');

let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(`${name}\n    기대: ${e}\n    실제: ${a}`); }
}

function ok(name, cond) { check(name, !!cond, true); }

// ── 도우미 ──────────────────────────────────────────────────────

function ctxOf({ width = 6, storage = 32, items = [], patterns = [], engravings = [], cellBase = null, fullHp = false }) {
  return opt.prepare({
    width, storage,
    cellBase: cellBase || new Array(storage).fill(0),
    fullHp, items, patterns, engravings,
  });
}

function charm(idx, extra = {}) {
  return Object.assign({
    iid: 1000 + idx, eid: 1, idx, kind: 'charm', name: 'c' + idx,
    charmType: true, maxLevel: 5, enchant: 0, criteria: null, magic: false,
  }, extra);
}

function tablet(idx, pat, extra = {}) {
  return Object.assign({
    iid: 2000 + idx, eid: 2, idx, kind: 'tablet', name: 't' + idx,
    charmType: false, rot: 0, rotatable: false, pat,
  }, extra);
}

function place(ctx) {
  const p = new Int32Array(ctx.items.length);
  const r = new Int32Array(ctx.items.length);
  ctx.items.forEach((it, i) => { p[i] = it.homeIdx; r[i] = it.rot; });
  return { p, r };
}

// ── 1. 격자 기하 ────────────────────────────────────────────────
// storage=32, width=6 이면 마지막 줄은 2칸뿐이다 (idx 30, 31).

{
  const ctx = ctxOf({ storage: 32, items: [charm(0)] });
  check('height = ceil(32/6)', ctx.height, 6);
  check('8방향 이웃: 좌상단 모서리', opt.neighbors8(ctx, 0).filter(n => n >= 0).sort((a, b) => a - b), [1, 6, 7]);
  // idx 31 은 마지막 줄 두 번째 칸. 아래쪽/오른쪽은 storage 밖이라 -1
  check('8방향 이웃: 마지막 칸', opt.neighbors8(ctx, 31).filter(n => n >= 0).sort((a, b) => a - b), [24, 25, 26, 30]);
}

// ── 2. 발동조건 ─────────────────────────────────────────────────
// 예전 구현은 아래 세 개를 'height-1' 기준으로 잘못 짰다.

{
  const ctx = ctxOf({ storage: 32, items: [] });
  const occ = new Int32Array(32).fill(-1);
  const met = (crit, cell) => opt.criteriaMet(ctx, { criteria: crit, isCharmType: true }, cell, occ, []);

  // BottomInInventory = 마지막 6칸(선형). storage=32 이므로 idx 26..31
  ok('Bottom: idx26 만족', met('CharmActivateCriteria_BottomInInventory', 26));
  ok('Bottom: idx25 불만족', !met('CharmActivateCriteria_BottomInInventory', 25));
  ok('Bottom: 마지막 줄이 아닌 26도 만족 (줄 기준이 아님)', met('CharmActivateCriteria_BottomInInventory', 26));

  // Inside = x,y 내부 && idx <= storage-8 (=24)
  ok('Inside: idx13(x=1,y=2) 만족', met('CharmActivateCriteria_Inside', 13));
  ok('Inside: x=0 불만족', !met('CharmActivateCriteria_Inside', 12));
  ok('Inside: idx25 는 선형경계 초과로 불만족', !met('CharmActivateCriteria_Inside', 25));

  // Outlined 는 Inside 의 여집합이 아니다: 둘 다 아닌 칸이 존재한다
  const inside = met('CharmActivateCriteria_Inside', 25);
  const outlined = met('CharmActivateCriteria_Outlined', 25);
  ok('idx25 는 Inside 도 Outlined 도 아니다 (사각지대)', !inside && !outlined);

  // SideEnd 는 상수 5
  ok('SideEnd: x=0 만족', met('CharmActivateCriteria_SideEnd', 6));
  ok('SideEnd: x=5 만족', met('CharmActivateCriteria_SideEnd', 11));
  ok('SideEnd: x=3 불만족', met('CharmActivateCriteria_SideEnd', 9) === false);

  // 모르는 조건은 false (점수 부풀리기 방지)
  ok('알 수 없는 조건은 false', !met('CharmActivateCriteria_Unknown', 10));

  // FullHP 는 배치와 무관
  ok('FullHP: fullHp=false 면 불만족', !met('CharmActivateCriteria_FullHP', 10));
}

{
  // NeighborsAreFull 은 8방향 전부
  const items = [charm(7), charm(0), charm(1), charm(2), charm(6), charm(8), charm(12), charm(13), charm(14)];
  const ctx = ctxOf({ storage: 32, items });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  ok('NeighborsAreFull: 8칸 모두 차면 만족',
    opt.criteriaMet(ctx, { criteria: 'CharmActivateCriteria_NeighborsAreFull' }, 7, ev.occupant, ctx.items));

  const ctx2 = ctxOf({ storage: 32, items: [charm(7), charm(0), charm(1)] });
  const q = place(ctx2);
  const ev2 = opt.evaluate(ctx2, q.p, q.r);
  ok('NeighborsAreFull: 일부만 차면 불만족',
    !opt.criteriaMet(ctx2, { criteria: 'CharmActivateCriteria_NeighborsAreFull' }, 7, ev2.occupant, ctx2.items));
}

{
  // BothSideCharm: 이웃이 Charm 타입이어야 하고 석판은 안 된다
  const withCharms = ctxOf({ storage: 32, items: [charm(7), charm(6), charm(8)] });
  let s = place(withCharms);
  let ev = opt.evaluate(withCharms, s.p, s.r);
  ok('BothSideCharm: 양쪽이 참이면 만족',
    opt.criteriaMet(withCharms, { criteria: 'CharmActivateCriteria_BothSideCharm' }, 7, ev.occupant, withCharms.items));

  const withTablet = ctxOf({
    storage: 32,
    items: [charm(7), charm(6), tablet(8, -1)],
    patterns: [],
  });
  s = place(withTablet);
  ev = opt.evaluate(withTablet, s.p, s.r);
  ok('BothSideCharm: 한쪽이 석판이면 불만족',
    !opt.criteriaMet(withTablet, { criteria: 'CharmActivateCriteria_BothSideCharm' }, 7, ev.occupant, withTablet.items));
}

{
  // BothSidesAreEmpty: 부분 행에서는 오른쪽 칸이 없을 수 있다
  const ctx = ctxOf({ storage: 32, items: [charm(7)] });
  const s = place(ctx);
  const ev = opt.evaluate(ctx, s.p, s.r);
  ok('BothSidesAreEmpty: 양쪽 비면 만족',
    opt.criteriaMet(ctx, { criteria: 'CharmActivateCriteria_BothSidesAreEmpty' }, 7, ev.occupant, ctx.items));

  // storage=32 -> rem=2, height=6. y=5(마지막 줄) 에서 x=1 은 rem-1=1 보다 작지 않아 불만족
  ok('BothSidesAreEmpty: 부분 행 끝에서는 불만족',
    !opt.criteriaMet(ctx, { criteria: 'CharmActivateCriteria_BothSidesAreEmpty' }, 31, ev.occupant, ctx.items));
}

// ── 3. 석판 레벨 계산 ───────────────────────────────────────────

{
  // 석판이 idx7 에 있고 idx8 에 +2 를 준다. idx8 의 참은 인챈트 1.
  const patterns = [{
    iid: 2007, movable: true,
    rots: { '0': { '7': { e: [[8, opt.OP_INCREASE, 2]], c: [] } } },
  }];
  const ctx = ctxOf({
    storage: 32,
    items: [tablet(7, 0), charm(8, { enchant: 1, maxLevel: 5 })],
    patterns,
  });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  check('석판 +2 와 인챈트 1 이 합쳐진다', ev.level[8], 3);
  ok('참이 발동한다', ev.active[8] === 1);
}

{
  // MUL 은 합산 후 한 번만 곱한다: MUL/3 두 개면 x6
  const patterns = [
    { iid: 1, movable: true, rots: { '0': { '7': { e: [[8, opt.OP_MULTIPLY, 3]], c: [] } } } },
    { iid: 2, movable: true, rots: { '0': { '9': { e: [[8, opt.OP_MULTIPLY, 3]], c: [] } } } },
  ];
  const ctx = ctxOf({
    storage: 32,
    items: [tablet(7, 0), tablet(9, 1), charm(8, { enchant: 2, maxLevel: 99 })],
    patterns,
  });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  check('MUL/3 두 개는 x6 (x9 아님)', ev.level[8], 12);
}

{
  // 곱수 합이 0이면 곱하지 않는다
  const patterns = [
    { iid: 1, movable: true, rots: { '0': { '7': { e: [[8, opt.OP_MULTIPLY, 2]], c: [] } } } },
    { iid: 2, movable: true, rots: { '0': { '9': { e: [[8, opt.OP_MULTIPLY, -2]], c: [] } } } },
  ];
  const ctx = ctxOf({
    storage: 32,
    items: [tablet(7, 0), tablet(9, 1), charm(8, { enchant: 3, maxLevel: 99 })],
    patterns,
  });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  check('곱수 합 0 이면 곱하지 않는다', ev.level[8], 3);
}

{
  // Disable 은 레벨을 남기되 발동만 막는다
  const patterns = [{ iid: 1, movable: true, rots: { '0': { '7': { e: [[8, opt.OP_DISABLE, 0]], c: [] } } } }];
  const ctx = ctxOf({
    storage: 32,
    items: [tablet(7, 0), charm(8, { enchant: 4 })],
    patterns,
  });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  check('Disable 이어도 레벨은 남는다', ev.level[8], 4);
  ok('Disable 이면 발동하지 않는다', ev.active[8] === 0);
}

{
  // IgnoreCriteria 는 조건을 무시하게 한다
  const patterns = [{ iid: 1, movable: true, rots: { '0': { '7': { e: [[8, opt.OP_IGNORE, 0]], c: [] } } } }];
  const ctx = ctxOf({
    storage: 32,
    // idx8 은 y=1,x=2 이라 TopInInventory 를 만족하지 못한다
    items: [tablet(7, 0), charm(8, { criteria: 'CharmActivateCriteria_TopInInventory' })],
    patterns,
  });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  ok('IgnoreCriteria 로 조건 불만족이어도 발동', ev.active[8] === 1);
}

// ── 4. 석판 자체 발동조건 ───────────────────────────────────────

{
  // ITEM 조건: idx6 에 아이템이 있어야 발동
  const patterns = [{
    iid: 1, movable: true,
    rots: { '0': { '7': { e: [[8, opt.OP_INCREASE, 5]], c: [[6, 1]] } } },
  }];

  const without = ctxOf({ storage: 32, items: [tablet(7, 0), charm(8)], patterns });
  let s = place(without);
  check('석판 조건 불만족이면 효과 없음', opt.evaluate(without, s.p, s.r).level[8], 0);

  const with_ = ctxOf({ storage: 32, items: [tablet(7, 0), charm(8), charm(6)], patterns });
  s = place(with_);
  check('석판 조건 만족하면 효과 적용', opt.evaluate(with_, s.p, s.r).level[8], 5);
}

{
  // PLACED 조건: 석판이 특정 칸에 있어야 발동 (OR)
  const patterns = [{
    iid: 1, movable: true,
    rots: {
      '0': {
        '7': { e: [[8, opt.OP_INCREASE, 3]], c: [[0, 3]] },   // idx0 에 놓여야 함 -> 불만족
        '0': { e: [[1, opt.OP_INCREASE, 3]], c: [[0, 3]] },   // idx0 에 놓임 -> 만족
      },
    },
  }];

  const bad = ctxOf({ storage: 32, items: [tablet(7, 0), charm(8)], patterns });
  let s = place(bad);
  check('PLACED 불만족이면 효과 없음', opt.evaluate(bad, s.p, s.r).level[8], 0);

  const good = ctxOf({ storage: 32, items: [tablet(0, 0), charm(1)], patterns });
  s = place(good);
  check('PLACED 만족하면 효과 적용', opt.evaluate(good, s.p, s.r).level[1], 3);
}

// ── 5. 점수 / 탐색 ──────────────────────────────────────────────

{
  // maxLevel 을 넘는 부분은 점수에 반영되지 않는다
  const patterns = [{ iid: 1, movable: true, rots: { '0': { '7': { e: [[8, opt.OP_INCREASE, 10]], c: [] } } } }];
  const ctx = ctxOf({
    storage: 32,
    items: [tablet(7, 0), charm(8, { maxLevel: 3 })],
    patterns,
  });
  const { p, r } = place(ctx);
  const ev = opt.evaluate(ctx, p, r);
  check('레벨은 10 이지만', ev.level[8], 10);
  check('점수는 maxLevel 3 으로 잘린다', opt.score(ctx, ev, { mode: 'even' }),
    3 + (3 * 10 - (3 - 3) * 2));
}

{
  // 탐색이 실제로 점수를 개선하는가:
  // 석판은 idx0 에 놓였을 때만 idx1 에 +5 를 준다. 참은 idx20 에 있다.
  // 최적해는 석판을 idx0, 참을 idx1 로 옮기는 것.
  const patterns = [{
    iid: 1, movable: true,
    rots: {
      '0': {
        '0': { e: [[1, opt.OP_INCREASE, 5]], c: [] },
        '20': { e: [], c: [] },
        '1': { e: [], c: [] },
        '2': { e: [], c: [] },
      },
    },
  }];
  const ctx = ctxOf({
    storage: 24,
    items: [tablet(20, 0), charm(2, { maxLevel: 5 })],
    patterns,
  });

  // 결정적 결과를 위해 시드 고정 난수
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const res = opt.optimize(ctx, { mode: 'even', iterations: 4000, random: rand });
  ok('탐색이 시작 점수보다 나은 배치를 찾는다', res.bestScore > res.startScore);
}

{
  // 콤보 가중치가 우선순위를 반영하는가
  const weightOf = opt.makeWeightFn(['A', 'B'], it => it.cats || []);
  const wA = weightOf({ cats: ['A'] });
  const wB = weightOf({ cats: ['B'] });
  const wNone = weightOf({ cats: ['Z'] });
  ok('1순위 콤보 가중치가 가장 크다', wA > wB && wB > wNone);
  check('목록에 없는 콤보는 가중치 1', wNone, 1);
}

// ── 결과 ────────────────────────────────────────────────────────

console.log(`\n통과 ${pass} / 실패 ${fail}`);
if (failures.length) {
  console.log('\n실패 목록:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('전부 통과');
