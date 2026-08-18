// 엔티티 호버 툴팁 (아티팩트·무기·코스튬·기적).
//
// title 속성은 뜨는 데 1초 넘게 걸리고 줄바꿈도 안 된다.
// 아이템 효과, 무기 트리/계열 효과, 코스튬 해금조건/스탯 효과를
// 빠르고 미려하게 보여주기 위해 커스텀 툴팁을 제공한다.

'use strict';

const { log, guard, esc } = require('./util');
const { ASSETS, entityInfo, comboById, comboKeyFromWikiSlug, slugIcon, slugName, weaponRootOf } = require('./gamedata');

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

/** 위키 효과 설명 내 $s..., $i..., \n 태그를 깔끔한 HTML 로 포맷 */
function formatWikiMarkup(text) {
  if (!text) return '';
  let cleaned = String(text)
    .replace(/\$\$?[a-zA-Z가-힣]([^$]+)\$/g, '<b class="kw">$1</b>')
    .replace(/\\n/g, '<br>')
    .replace(/\n/g, '<br>');
  return cleaned;
}

function renderWeaponTooltip(wiki, el) {
  const name = wiki ? (wiki.label_kor || wiki.value_kor) : (el.dataset.name || el.dataset.slug || '무기');
  const tier = wiki && wiki.tier ? wiki.tier : 1;
  const root = wiki ? weaponRootOf(wiki.value) : null;
  const rootName = root ? slugName('weapons', root) : '';
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) || slugIcon('weapons', wiki?.value);

  const rewards = ((wiki && wiki.effects && wiki.effects.reward) || [])
    .filter(Boolean)
    .map(r => formatWikiMarkup(r));

  let html =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${iconSrc}" onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub">` +
    `<span class="tt-badge tier">${tier}티어 무기</span>` +
    (root && root !== wiki?.value ? ` <span class="tt-badge root">${esc(rootName)} 계열</span>` : '') +
    `</div></div></div>`;

  if (rewards.length > 0) {
    html += `<div class="tt-effect">` +
      rewards.map(r => `<div class="tt-weapon-effect">✦ ${r}</div>`).join('') +
      `</div>`;
  }

  return html;
}

function renderCostumeTooltip(wiki, el) {
  const name = wiki ? wiki.label_kor : (el.dataset.name || el.dataset.slug || '코스튬');
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) || slugIcon('costume', wiki?.value);

  let html =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${iconSrc}" onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub"><span class="tt-badge costume">코스튬 / 캐릭터</span></div>` +
    `</div></div>`;

  if (wiki && wiki.unlock) {
    html += `<div class="tt-unlock">🔓 해금: ${esc(wiki.unlock)}</div>`;
  }

  if (wiki && wiki.description) {
    html += `<div class="tt-flavor">${esc(wiki.description)}</div>`;
  }

  const pos = (wiki && wiki.effects && wiki.effects.positive) || [];
  const neg = (wiki && wiki.effects && wiki.effects.negative) || [];

  if (pos.length > 0 || neg.length > 0) {
    html += `<div class="tt-costume-effects">`;
    pos.forEach(p => {
      html += `<div class="tt-costume-pos">▲ ${esc(p)}</div>`;
    });
    neg.forEach(n => {
      html += `<div class="tt-costume-neg">▼ ${esc(n)}</div>`;
    });
    html += `</div>`;
  }

  return html;
}

function renderMiracleTooltip(wiki, el) {
  const name = wiki ? (wiki.label_kor || wiki.value_kor) : (el.dataset.name || el.dataset.slug || '기적');
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) || slugIcon('miracle', wiki?.value);

  let html =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${iconSrc}" onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub"><span class="tt-badge miracle">기적</span></div>` +
    `</div></div>`;

  const rewards = (wiki && wiki.effects && wiki.effects.reward) || [];
  const penalties = (wiki && wiki.effects && wiki.effects.penalty) || [];

  if (rewards.length > 0 || penalties.length > 0) {
    html += `<div class="tt-costume-effects">`;
    rewards.forEach(r => {
      html += `<div class="tt-costume-pos">▲ ${esc(r)}</div>`;
    });
    penalties.forEach(p => {
      html += `<div class="tt-costume-neg">▼ ${esc(p)}</div>`;
    });
    html += `</div>`;
  }

  return html;
}

function renderArtifactTooltip(wiki, game, el) {
  const name = (game && (game.displayName || game.name)) || (wiki && wiki.label_kor) || el.dataset.slug || '아티팩트';
  const owned = el.classList.contains('owned');
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) ||
                  (game ? `${ASSETS}/icons/${game.id}.png` : slugIcon('artifacts', el.dataset.slug));

  const cats = (game && game.categories) || (wiki && wiki.effect && wiki.effect.sets) || [];
  const comboRow = cats.map(c => {
    const key = comboKeyFromWikiSlug(c);
    const combo = comboById(key) || comboById(c);
    return `<span class="tt-combo"><img src="${ASSETS}/combos/${key}.png" ` +
           `onerror="this.remove()">${esc((combo && combo.name) || key || c)}</span>`;
  }).join('');

  const effect = wiki && wiki.effect && wiki.effect.content
    ? formatWikiMarkup(wiki.effect.content)
    : (game && game.description ? esc(game.description).replace(/\n/g, '<br>') : '');

  return `
    <div class="tt-head">
      <img class="tt-icon" src="${iconSrc}" onerror="this.remove()">
      <div>
        <div class="tt-name">${esc(name)}</div>
        <div class="tt-sub">${wiki && wiki.tier ? `<span class="tt-badge tier">${esc(wiki.tier)}</span>` : ''}` +
        `${game && game.maxLevel != null ? ` · 최대 ${game.maxLevel}강` : ''}` +
        `${owned ? ' · <b class="tt-owned">보유 중</b>' : ''}</div>
      </div>
    </div>` +
    (comboRow ? `<div class="tt-combos">${comboRow}</div>` : '') +
    (effect ? `<div class="tt-effect">${effect}</div>` : '') +
    (wiki && wiki.description ? `<div class="tt-flavor">${esc(wiki.description)}</div>` : '');
}

function showTooltip(el) {
  const cat = el.dataset.cat || (el.classList.contains('weapons') ? 'weapons' :
                                el.classList.contains('costume') ? 'costume' :
                                el.classList.contains('miracle') ? 'miracle' : 'artifacts');
  const slug = el.dataset.slug;
  const id = el.dataset.id;
  const name = el.dataset.name;

  const info = entityInfo(cat, slug, id, name);
  if (!info.wiki && !info.game && !name && !slug) return;

  const tip = ensureTooltip();

  if (cat === 'weapons') {
    tip.innerHTML = renderWeaponTooltip(info.wiki, el);
  } else if (cat === 'costume') {
    tip.innerHTML = renderCostumeTooltip(info.wiki, el);
  } else if (cat === 'miracle') {
    tip.innerHTML = renderMiracleTooltip(info.wiki, el);
  } else {
    tip.innerHTML = renderArtifactTooltip(info.wiki, info.game, el);
  }

  tip.classList.remove('hidden');
  positionTooltip(tip, el);
}

function positionTooltip(tip, el) {
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const margin = 8;

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

function getTargetElement(e) {
  return e.target.closest(
    '.it[data-slug], .it[data-id], .bd-icon, .bc-icon, .team-meta .chip[data-cat], .team-meta .chip'
  );
}

/**
 * 툴팁 전역 위임 바인딩 (1회).
 */
function setupArtifactTooltips() {
  document.addEventListener('mouseover', guard('tooltip', e => {
    if (tooltipPinned) return;
    const el = getTargetElement(e);
    if (el) showTooltip(el);
  }));

  document.addEventListener('mouseout', guard('tooltip', e => {
    if (tooltipPinned) return;
    const el = getTargetElement(e);
    if (el && !el.contains(e.relatedTarget)) hideTooltip();
  }));

  document.addEventListener('click', guard('tooltip', e => {
    const el = getTargetElement(e);
    if (!el) {
      if (tooltipPinned) {
        tooltipPinned = false;
        hideTooltip();
      }
      return;
    }
    e.stopPropagation();
    if (tooltipPinned) {
      tooltipPinned = false;
      hideTooltip();
    } else {
      showTooltip(el);
      tooltipPinned = true;
    }
  }));

  log.info('tooltip', '전역 위임 바인딩 완료');
}

module.exports = { setupArtifactTooltips, resetTooltip };
