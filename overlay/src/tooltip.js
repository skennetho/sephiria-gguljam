// 엔티티 호버 툴팁 (아티팩트·무기·코스튬·기적·콤보 시너지).
//
// title 속성은 뜨는 데 1초 넘게 걸리고 줄바꿈도 안 된다.
// 아이템 효과, 무기 트리/계열 효과, 코스튬 해금조건/스탯 효과, 콤보 단계별 효과를
// 빠르고 미려하게 보여주기 위해 커스텀 툴팁을 제공한다.
// 최적배치 격자(Ctrl+D), 위키 빌드(Ctrl+B), 팀원창(F1) 전체에 일관 적용된다.

'use strict';

const { log, guard, esc } = require('./util');
const i18n = require('./i18n');
const {
  ASSETS, entityInfo, comboInfo, comboName, comboIcon, renderComboBadge,
  rarityName, slugIcon, slugName, weaponRootOf, weaponRecords, weaponByName, miracleByName
} = require('./gamedata');

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

/** 위키 효과 설명 내 $s..., $i..., $f..., $d..., $l..., $n... 태그 및 줄바꿈을 깔끔한 HTML 로 포맷 */
function formatWikiMarkup(text) {
  if (!text) return '';
  return String(text)
    .replace(/\$s([0-9a-fA-F]{6})/g, '<span style="color:#$1">')
    .replace(/\$[sfdiln]/g, '<span style="color:#ffd75e;font-weight:600">')
    .replace(/\$/g, '')
    .replace(/\\n/g, '<br>')
    .replace(/\n/g, '<br>');
}

function renderWeaponTooltip(wiki, el) {
  const name = wiki ? (wiki.label_kor || wiki.value_kor) : (el.dataset.name || el.dataset.slug || i18n.t('tt.weapon'));
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) || slugIcon('weapons', wiki?.value);
  const tier = wiki?.tier || (el.dataset.tier ? parseInt(el.dataset.tier, 10) : 1);

  // 1티어, 2티어, 3티어 무기 계통도 추적
  let tier1 = null;
  let tier2 = null;
  let tier3 = null;

  if (wiki) {
    if (tier === 3) {
      tier3 = wiki;
      tier2 = (weaponRecords && wiki.parent && weaponRecords[wiki.parent]) || null;
      const rootSlug = weaponRootOf(wiki.value);
      tier1 = (tier2 && tier2.parent && weaponRecords[tier2.parent]) || (rootSlug && weaponRecords[rootSlug]) || null;
    } else if (tier === 2) {
      tier2 = wiki;
      const rootSlug = weaponRootOf(wiki.value) || wiki.parent;
      tier1 = (rootSlug && weaponRecords[rootSlug]) || null;
    } else if (tier === 1) {
      tier1 = wiki;
    }
  }

  const t1Name = tier1 ? (tier1.label_kor || tier1.value_kor) : '';
  const t2Name = tier2 ? (tier2.label_kor || tier2.value_kor) : '';

  let treeHtml = '';
  if (tier === 3 && t2Name) {
    treeHtml = `<div class="tt-weapon-tree">` +
      (t1Name ? `<span class="tt-tree-node">${i18n.t('tt.tier', { tier: 1 })}: <b>${esc(t1Name)}</b></span> ➔ ` : '') +
      `<span class="tt-tree-node">${i18n.t('tt.tier', { tier: 2 })}: <b>${esc(t2Name)}</b></span> ➔ ` +
      `<span class="tt-tree-node active">${i18n.t('tt.tier', { tier: 3 })}: <b>${esc(name)}</b></span>` +
      `</div>`;
  } else if (tier === 2 && t1Name) {
    treeHtml = `<div class="tt-weapon-tree">` +
      `<span class="tt-tree-node">${i18n.t('tt.tier', { tier: 1 })}: <b>${esc(t1Name)}</b></span> ➔ ` +
      `<span class="tt-tree-node active">${i18n.t('tt.tier', { tier: 2 })}: <b>${esc(name)}</b></span>` +
      `</div>`;
  } else if (tier === 1) {
    treeHtml = `<div class="tt-weapon-tree"><span class="tt-tree-node active">${i18n.t('tt.tier1Base')}</span></div>`;
  }

  let html =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${iconSrc}" onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub"><span class="tt-badge weapon">${i18n.t('tt.weapon')}</span> · <span class="tt-badge level">${i18n.t('tt.tier', { tier })}</span>` +
    (t2Name && tier === 3 ? ` · <span class="tt-badge root">${i18n.t('tt.tier', { tier: 2 })}: ${esc(t2Name)}</span>` : '') +
    `</div></div></div>` +
    treeHtml;

  // 무기 효과 목록
  const rewards = (wiki && wiki.effects && wiki.effects.reward) || [];
  if (rewards.length > 0) {
    html += `<div class="tt-weapon-effects">`;
    rewards.forEach((r, i) => {
      if (!r) return;
      let label = '';
      if (tier === 3) {
        label = i === 0 ? `<span class="tt-effect-tag">${i18n.t('tt.tier2InheritedEffect', { name: t2Name ? esc(t2Name) : '' })}</span> `
                        : `<span class="tt-effect-tag highlight">${i18n.t('tt.tier3UniqueEffect')}</span> `;
      } else if (tier === 2) {
        label = `<span class="tt-effect-tag">${i18n.t('tt.tier2Effect')}</span> `;
      }
      html += `<div class="tt-effect">${label}${formatWikiMarkup(r)}</div>`;
    });
    html += `</div>`;
  } else if (wiki && wiki.effect) {
    if (wiki.effect.type) {
      html += `<div class="tt-weapon-type">${esc(wiki.effect.type)}</div>`;
    }
    if (wiki.effect.effect) {
      html += `<div class="tt-effect">${formatWikiMarkup(wiki.effect.effect)}</div>`;
    }
    if (wiki.effect.exclusive) {
      html += `<div class="tt-exclusive">${formatWikiMarkup(wiki.effect.exclusive)}</div>`;
    }
  }

  if (wiki && wiki.description) {
    html += `<div class="tt-flavor">${esc(wiki.description)}</div>`;
  }

  return html;
}

function renderCostumeTooltip(wiki, el) {
  const name = wiki ? wiki.label_kor : (el.dataset.name || el.dataset.slug || i18n.t('tt.costume'));
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) || slugIcon('costume', wiki?.value);

  let html =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${iconSrc}" onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub"><span class="tt-badge costume">${i18n.t('tt.costume')}</span></div>` +
    `</div></div>`;

  if (wiki && wiki.unlock) {
    html += `<div class="tt-unlock">${i18n.t('tt.unlock')} ${esc(wiki.unlock)}</div>`;
  }

  const pos = (wiki && wiki.effects && wiki.effects.positive) || [];
  const neg = (wiki && wiki.effects && wiki.effects.negative) || [];

  if (pos.length > 0 || neg.length > 0) {
    html += `<div class="tt-costume-effects">`;
    pos.forEach(p => {
      if (p) html += `<div class="tt-costume-pos">▲ ${formatWikiMarkup(p)}</div>`;
    });
    neg.forEach(n => {
      if (n) html += `<div class="tt-costume-neg">▼ ${formatWikiMarkup(n)}</div>`;
    });
    html += `</div>`;
  }

  return html;
}

function renderMiracleTooltip(wiki, el) {
  const name = wiki ? (wiki.label_kor || wiki.value_kor) : (el.dataset.name || el.dataset.slug || i18n.t('tt.miracle'));
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) || slugIcon('miracle', wiki?.value);

  let html =
    `<div class="tt-head">` +
    `<img class="tt-icon" src="${iconSrc}" onerror="this.remove()">` +
    `<div><div class="tt-name">${esc(name)}</div>` +
    `<div class="tt-sub"><span class="tt-badge miracle">${i18n.t('tt.miracle')}</span></div>` +
    `</div></div>`;

  const rewards = (wiki && wiki.effects && wiki.effects.reward) || [];
  const penalties = (wiki && wiki.effects && wiki.effects.penalty) || [];

  if (rewards.length > 0 || penalties.length > 0) {
    html += `<div class="tt-costume-effects">`;
    rewards.forEach(r => {
      if (r) html += `<div class="tt-costume-pos">▲ ${formatWikiMarkup(r)}</div>`;
    });
    penalties.forEach(p => {
      if (p) html += `<div class="tt-costume-neg">▼ ${formatWikiMarkup(p)}</div>`;
    });
    html += `</div>`;
  } else if (wiki && wiki.effect && wiki.effect.content) {
    html += `<div class="tt-effect">${formatWikiMarkup(wiki.effect.content)}</div>`;
  }

  if (wiki && wiki.description) {
    html += `<div class="tt-flavor">${esc(wiki.description)}</div>`;
  }

  return html;
}

function renderComboTooltip(comboKeyOrSlug, el) {
  const info = comboInfo(comboKeyOrSlug);
  if (!info) return '';

  const countEl = el && el.querySelector && el.querySelector('.cb-count');
  const count = countEl ? parseInt(countEl.textContent, 10) : (el?.dataset?.count ? parseInt(el.dataset.count, 10) : 0);

  const tiers = (info.combo && info.combo.tiers) || (info.combo && info.combo.comboTiers) || [];
  
  let tiersHtml = '';
  if (tiers.length > 0) {
    tiersHtml = '<div class="tt-combo-tiers">' + tiers.map(t => {
      const active = count >= t.count;
      return `<div class="tt-combo-tier${active ? ' active' : ''}">` +
             `<span class="tt-tier-req">${i18n.t('tt.setRequirement', { count: t.count })}</span> ` +
             `<span class="tt-tier-desc">${esc(t.effect || t.description || '')}</span>` +
             `</div>`;
    }).join('') + '</div>';
  }

  return `
    <div class="tt-head">
      <img class="tt-icon" src="${info.icon}" onerror="this.remove()">
      <div>
        <div class="tt-name">${esc(info.name)}</div>
        <div class="tt-sub"><span class="tt-badge" style="background:#1d3a52;color:#8fdcff">${i18n.t('tt.comboSynergy')}</span>${count > 0 ? ` · <span class="tt-badge level">${i18n.t('tt.ownedCount', { count })}</span>` : ''}</div>
      </div>
    </div>` +
    tiersHtml;
}

function renderArtifactTooltip(wiki, game, el) {
  const name = (game && (game.displayName || game.name)) || (wiki && wiki.label_kor) || el.dataset.name || el.dataset.slug || i18n.t('tt.artifact');
  const owned = el.classList.contains('owned');
  const iconSrc = (el.querySelector('img') && el.querySelector('img').src) ||
                  (game ? `${ASSETS}/icons/${game.id}.png` : slugIcon('artifacts', el.dataset.slug));

  const magicIcon = game?.magicIcon || (game?.isMagicBook ? `${game.id}_magic.png` : null);
  const magicOverlay = magicIcon ? `<img class="magic-overlay" src="${ASSETS}/icons/${magicIcon}" onerror="this.remove()">` : '';

  // 희귀도 뱃지 (일반, 고급, 희귀, 영웅, 전설, 신화)
  const rawRarity = el.dataset.rarity || game?.rarity || wiki?.tier || 'Common';
  const rName = rarityName(rawRarity);
  const rClass = String(rawRarity).toLowerCase();

  // 강화 레벨 및 상태
  const level = el.dataset.level;
  const maxLevel = el.dataset.maxLevel || game?.maxLevel;
  const criteria = el.dataset.criteria;
  const criteriaDesc = el.dataset.criteriaDesc;
  const isInactive = el.dataset.active === 'false';

  const subBadges = [];
  if (rawRarity) {
    subBadges.push(`<span class="tt-badge rarity ${esc(rClass)}">${esc(rName)}</span>`);
  }
  if (level != null && level !== '') {
    subBadges.push(`<span class="tt-badge level">${level}${maxLevel != null ? `/${maxLevel}` : ''}강</span>`);
  } else if (maxLevel != null) {
    subBadges.push(`<span class="tt-badge level">최대 ${maxLevel}강</span>`);
  }
  if (owned) {
    subBadges.push(`<span class="tt-badge owned">${i18n.t('tt.owned')}</span>`);
  }
  if (isInactive) {
    subBadges.push(`<span class="tt-badge inactive">${i18n.t('tt.inactive')}</span>`);
  }

  const cats = (game && game.categories) || (wiki && wiki.effect && wiki.effect.sets) || [];
  const comboRow = cats.map(c => {
    return renderComboBadge(c, { className: 'tt-combo' });
  }).join('');

  const effect = wiki && wiki.effect && wiki.effect.content
    ? formatWikiMarkup(wiki.effect.content)
    : (game && game.description ? esc(game.description).replace(/\n/g, '<br>') : '');

  let criteriaNotice = '';
  if (criteria && criteria !== 'Always') {
    criteriaNotice = `<div class="tt-criteria">${i18n.t('tt.condition')} <b>${esc(criteriaDesc || criteria)}</b></div>`;
  }

  return `
    <div class="tt-head">
      <div class="tt-icon-wrap">
        <img class="tt-icon" src="${iconSrc}" onerror="this.remove()">
        ${magicOverlay}
      </div>
      <div>
        <div class="tt-name">${esc(name)}</div>
        <div class="tt-sub">${subBadges.join(' ')}</div>
      </div>
    </div>` +
    (comboRow ? `<div class="tt-combos">${comboRow}</div>` : '') +
    (criteriaNotice || '') +
    (effect ? `<div class="tt-effect">${effect}</div>` : '') +
    (wiki && wiki.description ? `<div class="tt-flavor">${esc(wiki.description)}</div>` : '');
}

function showTooltip(el) {
  const isCombo = el.classList.contains('combo-badge') || el.classList.contains('tt-combo') || el.classList.contains('prio-row') || el.dataset.combo != null;
  const comboKey = el.dataset.combo || el.dataset.id || el.getAttribute('data-combo');

  if (isCombo && comboKey) {
    const tip = ensureTooltip();
    tip.innerHTML = renderComboTooltip(comboKey, el);
    tip.classList.remove('hidden');
    positionTooltip(tip, el);
    return;
  }

  const cat = el.dataset.cat || (el.classList.contains('weapons') ? 'weapons' :
                                el.classList.contains('costume') ? 'costume' :
                                el.classList.contains('miracle') ? 'miracle' : 'artifacts');
  const slug = el.dataset.slug;
  const id = el.dataset.id;
  const name = el.dataset.name;

  const info = entityInfo(cat, slug, id, name);
  if (!info.wiki && !info.game && !name && !slug && !id) return;

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
    '.it[data-slug], .it[data-id], .bd-icon, .bc-icon, .team-meta .chip, .combo-badge, .tt-combo, .prio-row, .cell[data-id], .cell[data-name], .summary-item, .summary-meta-chip, [data-cat]'
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
