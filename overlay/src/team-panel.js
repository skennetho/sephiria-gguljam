// 팀원 빌드 패널 (F1).
//
// 플러그인이 team_update 를 보내면 팀원 탭과 인벤토리 격자를 그린다.
// (플러그인 쪽 전송은 M3 예정 — UI 는 데이터가 오면 바로 동작한다)

'use strict';

const { esc } = require('./util');
const { ASSETS, renderComboBadge } = require('./gamedata');
const i18n = require('./i18n');
const ws = require('./ws');
const { renderGridInto } = require('./grid');

let team = [];        // 팀원 목록
let teamActive = 0;   // 선택된 팀원 탭

function init() {
  ws.on('team_update', data => {
    team = (data && data.members) || [];
    if (teamActive >= team.length) teamActive = 0;
    renderTeam();
  });

  i18n.onLanguageChange(() => {
    renderTeam();
  });
}

function renderTeam() {
  const tabs = document.getElementById('team-tabs');
  const body = document.getElementById('team-body');

  if (!team.length) {
    tabs.innerHTML = '';
    body.innerHTML = `<div class="empty">${i18n.t('team.empty')}</div>`;
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
  if (m.costume) chips.push(`<span class="chip" data-cat="costume" data-name="${esc(m.costume)}" style="cursor:pointer">${i18n.t('team.costume')} <b>${esc(m.costume)}</b></span>`);
  if (m.weapon) chips.push(`<span class="chip" data-cat="weapons" data-name="${esc(m.weapon)}" style="cursor:pointer">${i18n.t('team.weapon')} <b>${esc(m.weapon)}</b></span>`);
  if (m.miracle) chips.push(`<span class="chip" data-cat="miracle" data-name="${esc(m.miracle)}" style="cursor:pointer">${i18n.t('team.miracle')} <b>${esc(m.miracle)}</b></span>`);
  for (const c of (m.combos || [])) {
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
