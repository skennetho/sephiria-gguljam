// 팀원 빌드 패널 (F1).
//
// 플러그인이 team_update 를 보내면 전체 요약 또는 개별 상세 격자를 그린다.

'use strict';

const { esc } = require('./util');
const gamedata = require('./gamedata');
const { ASSETS, renderComboBadge, itemById, weaponByName, miracleByName, slugIcon } = gamedata;
const i18n = require('./i18n');
const ws = require('./ws');
const { renderGridInto } = require('./grid');
const tooltip = require('./tooltip');

const VIEW_MODE_KEY = 'sephiria.team.viewMode';
let team = [];            // 팀원 목록
let teamActive = 0;       // 선택된 팀원 탭 (상세 뷰용)
let viewMode = 'summary'; // 'summary' (전체 요약) | 'detail' (개별 상세)
try {
  const saved = localStorage.getItem(VIEW_MODE_KEY);
  if (saved === 'summary' || saved === 'detail') viewMode = saved;
} catch {}
let lastTeamSig = '';     // 변경 감지용 서명

function init() {
  ws.on('team_update', data => {
    team = (data && (Array.isArray(data.members) ? data.members : (Array.isArray(data) ? data : []))) || [];
    if (teamActive >= team.length) teamActive = 0;

    // 변경 서명 체크 (호버 중 불필요한 DOM 재생성 및 툴팁 깜빡임 방지)
    const sig = JSON.stringify(team.filter(Boolean).map(m => [
      m.name, m.weapon, m.miracle,
      (m.combos || []).filter(Boolean).map(c => [c.id || c.name, c.count]),
      ((m.inventory && m.inventory.items) || []).filter(Boolean).map(i => [i.entityID, i.level, i.isActive])
    ]));
    if (sig !== lastTeamSig) {
      lastTeamSig = sig;
      renderTeam();
    }
  });

  i18n.onLanguageChange(() => {
    lastTeamSig = '';
    renderTeam();
  });
}

function setViewMode(mode) {
  if (viewMode === mode) return;
  viewMode = mode;
  try {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  } catch {}
  renderTeam();
}

function renderTeam() {
  const tabs = document.getElementById('team-tabs');
  const body = document.getElementById('team-body');

  if (!team.length) {
    tabs.innerHTML = '';
    body.innerHTML = `<div class="empty">${i18n.t('team.empty')}</div>`;
    return;
  }

  // 1. 모드 토글 바 (전체 요약 <-> 개별 상세)
  tabs.innerHTML = '';

  const modeBar = document.createElement('div');
  modeBar.className = 'team-mode-bar';

  const btnSummary = document.createElement('button');
  btnSummary.className = 'team-mode-btn' + (viewMode === 'summary' ? ' on' : '');
  btnSummary.textContent = i18n.t('team.tabSummary');
  btnSummary.addEventListener('click', () => setViewMode('summary'));

  const btnDetail = document.createElement('button');
  btnDetail.className = 'team-mode-btn' + (viewMode === 'detail' ? ' on' : '');
  btnDetail.textContent = i18n.t('team.tabDetail');
  btnDetail.addEventListener('click', () => setViewMode('detail'));

  modeBar.appendChild(btnSummary);
  modeBar.appendChild(btnDetail);
  tabs.appendChild(modeBar);

  body.innerHTML = '';

  if (viewMode === 'summary') {
    renderSummaryView(body);
  } else {
    renderDetailView(tabs, body);
  }

  tooltip.resetTooltip();
}

function renderSummaryView(body) {
  const container = document.createElement('div');
  container.className = 'team-summary-list';

  team.filter(Boolean).forEach((m, idx) => {
    const card = document.createElement('div');
    card.className = 'team-summary-card';

    // ── Row 1: 무기 / 기적 / 활성 콤보 아이콘과 수 ──
    const rowTop = document.createElement('div');
    rowTop.className = 'summary-row-top';

    // 팀원 이름
    const nameSpan = document.createElement('span');
    nameSpan.className = 'summary-member-name';
    nameSpan.textContent = m.name || i18n.t('team.memberNum', { num: idx + 1 });
    rowTop.appendChild(nameSpan);

    // 무기 미니 칩 (아이콘 + 이름)
    if (m.weapon) {
      const wRec = weaponByName(m.weapon);
      const wIcon = wRec ? slugIcon('weapons', wRec.value) : null;
      const wChip = document.createElement('span');
      wChip.className = 'summary-meta-chip weapon';
      wChip.dataset.cat = 'weapons';
      wChip.dataset.name = m.weapon;
      if (wRec) wChip.dataset.slug = wRec.value;
      wChip.innerHTML = (wIcon ? `<img src="${wIcon}" onerror="this.remove()">` : '') +
                        `<span>${esc(m.weapon)}</span>`;
      rowTop.appendChild(wChip);
    }

    // 기적 미니 칩 (있을 경우만 표시)
    if (m.miracle) {
      const mRec = miracleByName(m.miracle);
      const mIcon = mRec ? slugIcon('miracle', mRec.value) : null;
      const mChip = document.createElement('span');
      mChip.className = 'summary-meta-chip miracle';
      mChip.dataset.cat = 'miracle';
      mChip.dataset.name = m.miracle;
      if (mRec) mChip.dataset.slug = mRec.value;
      mChip.innerHTML = (mIcon ? `<img src="${mIcon}" onerror="this.remove()">` : '') +
                        `<span>${esc(m.miracle)}</span>`;
      rowTop.appendChild(mChip);
    }

    // 활성 콤보 배지 (아이콘 + 단계 수치)
    const combos = m.combos || [];
    if (combos.length > 0) {
      const comboWrap = document.createElement('div');
      comboWrap.className = 'summary-combos';
      for (const c of combos) {
        if (!c || !c.count || c.count <= 0) continue;
        const badgeHtml = renderComboBadge(c.id || c.name, {
          count: c.count,
          className: 'combo-badge summary-badge'
        });
        comboWrap.insertAdjacentHTML('beforeend', badgeHtml);
      }
      rowTop.appendChild(comboWrap);
    }

    card.appendChild(rowTop);

    // ── Row 2: 아티팩트 나열 (아이콘 + 강화 수치만) ──
    const rowItems = document.createElement('div');
    rowItems.className = 'summary-row-items';

    const rawItems = (m.inventory && m.inventory.items) || [];
    // [중복 제거] 2x2 석판 등 다중 칸 점유 아이템의 중복 표시 방지
    const seenInstances = new Set();
    const items = [];
    for (const it of rawItems) {
      if (!it || it.entityID == null) continue;
      const key = it.instanceID != null ? it.instanceID : `${it.entityID}_${it.x}_${it.y}`;
      if (seenInstances.has(key)) continue;
      seenInstances.add(key);
      items.push(it);
    }

    if (!items.length) {
      rowItems.innerHTML = `<span class="summary-no-items">${i18n.t('team.noItems')}</span>`;
    } else {
      // 정렬: 석판 우선 -> 활성화 부적 -> 비활성화 부적
      const sortedItems = [...items].sort((a, b) => {
        const dbA = itemById(a.entityID);
        const dbB = itemById(b.entityID);
        const isTabletA = dbA && dbA.type === 'StoneTablet' ? 1 : 0;
        const isTabletB = dbB && dbB.type === 'StoneTablet' ? 1 : 0;
        if (isTabletA !== isTabletB) return isTabletB - isTabletA;
        const actA = a.isActive !== false ? 1 : 0;
        const actB = b.isActive !== false ? 1 : 0;
        return actB - actA;
      });

      for (const it of sortedItems) {
        const db = itemById(it.entityID);
        const isTablet = db && db.type === 'StoneTablet';
        const rarity = (it.rarity || db?.rarity || 'Common').toLowerCase();
        const isActive = it.isActive !== false;

        const itemEl = document.createElement('span');
        itemEl.className = `summary-item rarity-${rarity}` +
          (isTablet ? ' tablet' : '') +
          (isActive ? '' : ' inactive');

        // 커스텀 툴팁 데이터 바인딩
        itemEl.dataset.cat = 'artifacts';
        itemEl.dataset.id = String(it.entityID);
        itemEl.dataset.name = it.name || db?.name || '';
        itemEl.dataset.level = String(it.level != null ? it.level : 0);
        itemEl.dataset.maxLevel = String(it.maxLevel != null ? it.maxLevel : (db?.maxLevel || 0));
        itemEl.dataset.rarity = it.rarity || db?.rarity || 'Common';
        itemEl.dataset.active = isActive ? 'true' : 'false';
        if (it.activateCriteria && it.activateCriteria !== 'Always') {
          itemEl.dataset.criteria = it.activateCriteria;
          itemEl.dataset.criteriaDesc = it.criteriaDescription || '';
        }

        const img = document.createElement('img');
        img.src = `${ASSETS}/icons/${it.entityID}.png`;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        itemEl.appendChild(img);

        const magicIcon = db?.magicIcon || (db?.isMagicBook ? `${it.entityID}_magic.png` : null);
        if (magicIcon) {
          const magic = document.createElement('img');
          magic.className = 'magic-overlay';
          magic.src = `${ASSETS}/icons/${magicIcon}`;
          magic.onerror = () => magic.remove();
          itemEl.appendChild(magic);
        }

        if (!isTablet && it.level != null) {
          const lv = document.createElement('span');
          lv.className = 'lv';
          lv.textContent = it.level;
          itemEl.appendChild(lv);
        }

        rowItems.appendChild(itemEl);
      }
    }

    card.appendChild(rowItems);
    container.appendChild(card);
  });

  body.appendChild(container);
}

function renderDetailView(tabs, body) {
  const memberTabs = document.createElement('div');
  memberTabs.className = 'team-member-tabs';

  team.filter(Boolean).forEach((member, idx) => {
    const tab = document.createElement('span');
    tab.className = 'team-tab' + (idx === teamActive ? ' on' : '');
    tab.textContent = member.name || i18n.t('team.playerNum', { num: idx + 1 });
    tab.addEventListener('click', () => {
      teamActive = idx;
      renderTeam();
    });
    memberTabs.appendChild(tab);
  });
  tabs.appendChild(memberTabs);

  const m = team[teamActive] || team[0];
  const meta = document.createElement('div');
  meta.className = 'team-meta';
  const chips = [];
  if (m.costume) chips.push(`<span class="chip" data-cat="costume" data-name="${esc(m.costume)}" style="cursor:pointer">${i18n.t('team.costume')} <b>${esc(m.costume)}</b></span>`);
  if (m.weapon) chips.push(`<span class="chip" data-cat="weapons" data-name="${esc(m.weapon)}" style="cursor:pointer">${i18n.t('team.weapon')} <b>${esc(m.weapon)}</b></span>`);
  if (m.miracle) chips.push(`<span class="chip" data-cat="miracle" data-name="${esc(m.miracle)}" style="cursor:pointer">${i18n.t('team.miracle')} <b>${esc(m.miracle)}</b></span>`);
  for (const c of (m.combos || [])) {
    if (!c || !c.count || c.count <= 0) continue;
    chips.push(renderComboBadge(c.id || c.name, {
      count: c.count,
      className: 'combo-badge'
    }));
  }
  meta.innerHTML = chips.join('');
  body.appendChild(meta);

  const grid = document.createElement('div');
  grid.className = 'mini-grid';
  renderGridInto(grid, m.inventory);
  body.appendChild(grid);
}

module.exports = { init };
