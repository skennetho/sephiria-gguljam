// 아티팩트 호버 툴팁.
//
// title 속성은 뜨는 데 1초 넘게 걸리고 줄바꿈도 안 된다.
// 아이템 효과와 콤보 소속을 바로 보려면 직접 그리는 편이 낫다.
//
// 상세 화면 컨테이너에 한 번만 위임으로 바인딩한다. 요소마다 걸면
// 재렌더 때마다 날아가서 툴팁이 뜨다 말게 된다 (실제로 겪은 회귀).

'use strict';

const { log, guard, esc } = require('./util');
const { ASSETS, artifactInfo, comboById } = require('./gamedata');

let tooltipEl = null;
let tooltipPinned = false;

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.id = 'artifact-tooltip';
  tooltipEl.className = 'artifact-tooltip hidden';
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function showTooltip(el) {
  const { wiki, game } = artifactInfo(el.dataset.slug, el.dataset.id);
  if (!wiki && !game) return;

  const tip = ensureTooltip();
  const name = (game && game.name) || (wiki && wiki.label_kor) || el.dataset.slug;
  const owned = el.classList.contains('owned');

  const cats = (game && game.categories) || [];
  const comboRow = cats.map(c => {
    const combo = comboById(c);
    return `<span class="tt-combo"><img src="${ASSETS}/combos/${c}.png" ` +
           `onerror="this.remove()">${esc((combo && combo.name) || c)}</span>`;
  }).join('');

  // 위키 효과 설명의 "a/b/c/d" 는 강화 단계별 수치다
  const effect = wiki && wiki.effect && wiki.effect.content
    ? esc(wiki.effect.content).replace(/\n/g, '<br>')
    : '';

  tip.innerHTML =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${el.querySelector('img') ? el.querySelector('img').src : ''}" ` +
    `onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub">${wiki && wiki.tier ? esc(wiki.tier) : ''}` +
    `${game && game.maxLevel != null ? ` · 최대 ${game.maxLevel}강` : ''}` +
    `${owned ? ' · <b class="tt-owned">보유 중</b>' : ''}</div></div></div>` +
    (comboRow ? `<div class="tt-combos">${comboRow}</div>` : '') +
    (effect ? `<div class="tt-effect">${effect}</div>` : '') +
    (wiki && wiki.description ? `<div class="tt-flavor">${esc(wiki.description)}</div>` : '');

  tip.classList.remove('hidden');
  positionTooltip(tip, el);
}

function positionTooltip(tip, el) {
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const margin = 8;

  // 기본은 왼쪽 (빌드 패널이 화면 오른쪽에 있으므로)
  let left = r.left - t.width - margin;
  if (left < margin) left = r.right + margin;

  let top = r.top;
  if (top + t.height > window.innerHeight - margin) {
    top = window.innerHeight - t.height - margin;
  }
  if (top < margin) top = margin;

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.add('hidden');
}

/** 재렌더 직후 호출: 떠 있던 툴팁과 고정 상태를 정리한다. */
function resetTooltip() {
  hideTooltip();
  tooltipPinned = false;
}

/**
 * 위임 바인딩 (1회). 클릭하면 고정(pin)되어 마우스를 떼도 유지 —
 * 다시 클릭하거나 다른 곳을 클릭하면 해제.
 */
function setupArtifactTooltips() {
  const view = document.getElementById('build-detail-view');

  view.addEventListener('mouseover', guard('tooltip', e => {
    if (tooltipPinned) return;
    const el = e.target.closest('.it[data-slug]');
    if (el) showTooltip(el);
  }));

  view.addEventListener('mouseout', guard('tooltip', e => {
    if (tooltipPinned) return;
    const el = e.target.closest('.it[data-slug]');
    // 자식(img)으로 이동한 것은 이탈이 아니다
    if (el && !el.contains(e.relatedTarget)) hideTooltip();
  }));

  view.addEventListener('click', guard('tooltip', e => {
    const el = e.target.closest('.it[data-slug]');
    if (!el) return;
    e.stopPropagation();   // 빌드 카드 클릭 등으로 번지지 않게
    if (tooltipPinned) {
      tooltipPinned = false;
      hideTooltip();
    } else {
      showTooltip(el);
      tooltipPinned = true;
    }
  }));

  // 다른 곳을 클릭하면 고정 해제
  document.addEventListener('click', e => {
    if (tooltipPinned && !e.target.closest('.it[data-slug]')) {
      tooltipPinned = false;
      hideTooltip();
    }
  });

  log.info('tooltip', '위임 바인딩 완료');
}

module.exports = { setupArtifactTooltips, resetTooltip };
