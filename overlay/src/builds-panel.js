// 위키 빌드 패널 (Ctrl+B).
//
// 전체 탭: 위키 API 를 옵션(상세검색)+페이지로 네트워크 검색한다.
// 즐겨찾기 탭: localStorage 의 로컬 목록. 옵션·페이저가 의미 없어 숨긴다.

'use strict';

const fs = require('fs');
const path = require('path');
const { ipcRenderer, shell } = require('electron');
const { log, guard, esc, sanitize } = require('./util');
const gamedata = require('./gamedata');
const {
  ASSETS, itemByName, comboById, combos,
  COMBO_TO_WIKI, comboKeyFromWikiSlug,
  comboInfo, comboName, comboIcon, renderComboBadge,
  slugName, slugIcon, slugCategories,
  weaponsByTier, weaponRootOf,
  skewerName, skewerIcon, ABILITY_LABELS,
} = gamedata;
const ws = require('./ws');
const tooltip = require('./tooltip');
const presetCodec = require('./preset-codec');

// ── 상태 ──────────────────────────────────────────────

let inventory = null;        // 보유 표시용 최신 인벤토리 (자체 구독)

let builds = [];
let buildDetail = null;
let buildTab = 'all';        // all | fav
let buildPage = 1;
let buildTotal = 0;
let buildPageSize = 10;

// 상세검색 필터 (위키의 '빌드 검색하기' 다이얼로그와 동일한 항목)
// text 는 isWriter 에 따라 작성자 검색 / 제목 검색으로 해석된다 (API: title + isWriter)
let searchFilters = { text: '', isWriter: true, costume: '', weapon: '', miracle: '', combo: '' };

// 즐겨찾기는 편의 기능이라 잃어버려도 상관없다. localStorage 로 충분하다.
const FAV_KEY = 'sephiria.favBuilds';
let favorites = loadFavorites();

// ── 초기화 ────────────────────────────────────────────

function init() {
  ws.on('inventory_update', data => {
    inventory = data;
    // 상세 화면을 통째로 다시 그리면 1~2초마다 호버 상태·스크롤이 리셋되어
    // 아이템 툴팁이 뜨자마자 사라진다. 보유 표시 클래스만 제자리에서 갱신한다.
    if (buildDetail) updateOwnedMarks();
  });

  ws.on('apply_preset_result', data => {
    if (data && data.ok) {
      showBuildToast(`🎉 인게임 슬롯 ${data.slot + 1}에 저장되었습니다!`);
    } else {
      showBuildToast(`⚠ 저장 실패: ${(data && data.message) || '오류 발생'}`);
    }
  });

  document.querySelectorAll('.build-tab').forEach(tab => {
    tab.addEventListener('click', guard('tab', () => {
      document.querySelectorAll('.build-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      buildTab = tab.dataset.tab;
      log.info('builds', '탭 전환', buildTab);
      renderBuildList();
      renderPager();
    }));
  });
  updateFavCount();

  // 옵션이 바뀌면 1페이지부터 다시 검색
  const restartSearch = guard('builds:option', () => { buildPage = 1; loadBuilds(); });
  document.getElementById('build-sort').addEventListener('change', restartSearch);
  document.getElementById('build-latest-only').addEventListener('change', restartSearch);

  document.getElementById('pager-prev').addEventListener('click', guard('pager', () => {
    if (buildPage > 1) { buildPage--; loadBuilds(); }
  }));
  document.getElementById('pager-next').addEventListener('click', guard('pager', () => {
    buildPage++; loadBuilds();
  }));

  setupAdvSearch();
  tooltip.setupArtifactTooltips();
  loadBuilds();
}

// ── 즐겨찾기 (localStorage + 파일 백업 이중 영구 보존) ──

function getFavoriteBackupPaths() {
  const paths = [];
  const appData = process.env.APPDATA || '';
  if (appData) {
    paths.push(path.join(appData, 'sephiria-gguljam', 'favorites.json'));
    paths.push(path.join(appData, 'Sephiria Tools Overlay', 'favorites.json'));
  }
  try {
    const pluginRoot = path.join(path.dirname(process.execPath), '..');
    paths.push(path.join(pluginRoot, 'favorites.json'));
  } catch {}
  return paths;
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    let arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr) || arr.length === 0) {
      // localStorage 가 비어 있다면 백업 파일(기존 저장본)에서 마이그레이션 복원
      for (const p of getFavoriteBackupPaths()) {
        if (fs.existsSync(p)) {
          try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
            if (Array.isArray(data) && data.length > 0) {
              arr = data;
              log.info('fav', `백업 파일(${p})에서 즐겨찾기 ${arr.length}개 자동 복원`);
              localStorage.setItem(FAV_KEY, JSON.stringify(arr));
              break;
            }
          } catch {}
        }
      }
    }
    return new Map(arr.map(b => [b.postUuid || String(b.id), b]));
  } catch (err) {
    log.warn('fav', '즐겨찾기 로드 실패 — 비우고 시작', err.message);
    return new Map();
  }
}

function saveFavorites() {
  try {
    const list = [...favorites.values()];
    const jsonStr = JSON.stringify(list, null, 2);
    localStorage.setItem(FAV_KEY, jsonStr);
    log.info('fav', '저장', { 개수: favorites.size });

    // 파일 시스템 백업에도 동시 저장 (폴더명 변경 및 캐시 초기화 대비)
    for (const p of getFavoriteBackupPaths()) {
      try {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, jsonStr, 'utf8');
      } catch {}
    }
  } catch (err) {
    log.warn('fav', '저장 실패', err.message);
  }
}

function buildKey(b) {
  return b.postUuid || String(b.id);
}

/** 위키 원본글 주소. postUuid 가 없으면 열 수 없다. */
function buildUrl(b) {
  return b.postUuid ? `https://www.sephiria.wiki/builds/${b.postUuid}` : null;
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

// ── 프리셋 생성 및 인게임 슬롯 주입 ──────────────────────

function showBuildToast(msg, duration = 3000) {
  let toast = document.getElementById('build-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'build-toast';
    toast.className = 'build-toast hidden';
    document.getElementById('panel-builds').appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, duration);
}

function openSlotPickerModal(b) {
  let modal = document.getElementById('preset-slot-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'preset-slot-modal';
    modal.className = 'preset-slot-modal hidden';
    document.getElementById('panel-builds').appendChild(modal);
  }

  modal.innerHTML =
    `<div class="psm-box">` +
    `<div class="psm-title">📥 저장할 인게임 프리셋 슬롯 선택</div>` +
    `<div class="psm-build-name">대상 빌드: <b>${esc(b.title)}</b></div>` +
    `<div class="psm-desc">선택한 슬롯에 이 빌드의 코스튬·무기·관심부적·재능·과일꼬치가 저장됩니다.</div>` +
    `<div class="psm-slots">` +
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<button class="psm-slot-btn" data-slot="${i}">슬롯 ${i + 1}</button>`).join('') +
    `</div>` +
    `<div class="psm-foot"><button class="psm-close-btn">닫기</button></div>` +
    `</div>`;

  modal.classList.remove('hidden');

  modal.querySelectorAll('.psm-slot-btn').forEach(btn => {
    btn.addEventListener('click', guard('psm:slot', () => {
      const slotIndex = parseInt(btn.dataset.slot, 10);
      modal.classList.add('hidden');
      const code = presetCodec.getOrGeneratePresetCode(b, gamedata);
      ws.send({
        type: 'apply_preset',
        slot: slotIndex,
        presetCode: code,
        title: b.title || '위키 프리셋'
      });
      showBuildToast(`인게임 슬롯 ${slotIndex + 1}에 저장을 요청했습니다…`);
    }));
  });

  modal.querySelector('.psm-close-btn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
}

function updateFavCount() {
  const el = document.getElementById('fav-count');
  if (el) el.textContent = String(favorites.size);
}

// ── 목록 ──────────────────────────────────────────────

async function loadBuilds() {
  const list = document.getElementById('build-list');
  list.innerHTML = '<div class="empty">불러오는 중…</div>';

  const sort = document.getElementById('build-sort').value;
  const latestOnly = document.getElementById('build-latest-only').checked;

  try {
    // 위키는 봇 UA 를 403 처리하므로 main 프로세스가 대신 받아온다.
    // 즐겨찾기가 아닌 목록은 항상 네트워크에서 최신을 가져온다 (연타 방지 캐시 60초).
    const r = await ipcRenderer.invoke('fetch-builds', {
      page: buildPage, sort, latestOnly, ...searchFilters,
    });
    builds = r.builds;
    buildTotal = r.total;
    buildPageSize = r.pageSize || 10;
    log.info('builds', '목록 수신', {
      개수: builds.length, 전체: buildTotal, page: buildPage,
      sort, latestOnly, 필터: JSON.stringify(searchFilters),
    });
    renderBuildList();
  } catch (err) {
    log.error('builds', '목록 요청 실패', err.message || String(err));
    list.innerHTML = `<div class="empty">빌드를 불러오지 못했습니다<br><small>${err.message || err}</small></div>`;
  }
  renderPager();
}

function renderPager() {
  const pager = document.getElementById('build-pager');
  const filters = document.getElementById('build-filters');

  // 즐겨찾기 탭은 로컬 목록이라 검색 옵션·페이지가 의미 없다
  const isFavTab = buildTab === 'fav';
  pager.classList.toggle('hidden', isFavTab);
  filters.classList.toggle('hidden', isFavTab);
  document.getElementById('adv-search').classList.add('hidden');
  if (isFavTab) {
    document.getElementById('active-filters').classList.add('hidden');
    return;
  }
  renderActiveFilters();

  const totalPages = Math.max(1, Math.ceil(buildTotal / buildPageSize));
  document.getElementById('pager-info').textContent = `${buildPage} / ${totalPages}`;
  document.getElementById('pager-prev').disabled = buildPage <= 1;
  document.getElementById('pager-next').disabled = buildPage >= totalPages;
}

function renderBuildList() {
  const list = document.getElementById('build-list');
  const shown = buildTab === 'fav' ? [...favorites.values()] : builds;

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
    box.dataset.cat = cat;
    box.dataset.slug = slug;
    box.title = `${label}: ${slugName(cat, slug)}`;
    const img = document.createElement('img');
    img.src = slugIcon(cat, slug);
    img.onerror = () => { box.classList.add('missing'); img.remove(); };
    box.appendChild(img);
    iconRow.appendChild(box);
  }

  // 대표 콤보 뱃지 (아이콘 + 한글명 필수)
  const comboBadgesHtml = (b.combo || [])
    .map(c => renderComboBadge(c, { className: 'bc-combo-tag' }))
    .join('');

  const body = document.createElement('div');
  body.className = 'bc-body';
  body.innerHTML =
    `<div class="bc-title-row">` +
    `<div class="bc-title">${esc(b.title)}</div>` +
    `</div>` +
    (comboBadgesHtml ? `<div class="bc-combos-row">${comboBadgesHtml}</div>` : '') +
    `<div class="bc-meta">` +
    `<span>${esc((b.writer && b.writer.nickname) || '')}</span>` +
    `<span class="bc-like">♥ ${b.postLike != null ? b.postLike : 0}</span>` +
    `<span>v${esc(b.version || '')}</span>` +
    `<span class="bc-actions">` +
    `<button class="bc-quick-btn copy-btn" title="프리셋 코드 복사">📋 복사</button>` +
    `<button class="bc-quick-btn apply-btn" title="인게임 슬롯에 저장">📥 저장</button>` +
    `</span>` +
    `</div>`;

  const copyBtn = body.querySelector('.copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', guard('card:copy', (e) => {
      e.stopPropagation();
      const code = presetCodec.getOrGeneratePresetCode(b, gamedata);
      if (code) {
        presetCodec.copyPresetCodeToClipboard(code);
        showBuildToast(`✔ '${b.title}' 프리셋 코드 복사 완료!`);
      }
    }));
  }

  const applyBtn = body.querySelector('.apply-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', guard('card:apply', (e) => {
      e.stopPropagation();
      openSlotPickerModal(b);
    }));
  }

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

// ── 상세 ──────────────────────────────────────────────

function ownedNameSet() {
  return new Set(
    ((inventory && inventory.items) || []).map(i => (i.name || '').replace(/\s/g, '')));
}

/** 인벤토리가 갱신될 때 상세 화면의 '보유 중' 표시만 제자리에서 바꾼다. */
function updateOwnedMarks() {
  const view = document.getElementById('build-detail-view');
  if (view.classList.contains('hidden')) return;

  const owned = ownedNameSet();
  view.querySelectorAll('.it[data-slug]').forEach(el => {
    const kor = slugName('artifacts', el.dataset.slug).replace(/\s/g, '');
    el.classList.toggle('owned', owned.has(kor));
  });
}

function renderBuildDetail(b) {
  const view = document.getElementById('build-detail-view');
  const owned = ownedNameSet();

  // 6대 재능 (기본 제외)
  const abilities = Object.entries(ABILITY_LABELS)
    .filter(([k]) => k !== 'base')
    .map(([k, label]) => {
      const v = b.ability?.[k] ?? 0;
      return `<div class="stat-box"><div class="sn">${label}</div>` +
             `<div class="sv${v === 0 ? ' zero' : ''}">${v}</div></div>`;
    }).join('');

  // 대표 콤보 뱃지
  const comboBadges = (b.combo || []).map(id => {
    return renderComboBadge(id, { className: 'combo-badge' });
  }).join('');

  const skewer = (b.fruit_skewer || [])
    .map(f => {
      const icon = skewerIcon(f.key);
      const sign = f.value > 0 ? '+' : '';
      return `<span class="skewer-item">` +
             (icon ? `<img src="${icon}" onerror="this.remove()">` : '') +
             `${esc(skewerName(f.key))} <b>${sign}${f.value}</b></span>`;
    })
    .join('');

  const sections = (b.content || []).map(sec => {
    const icons = (sec.items || []).map(it => {
      const kor = slugName('artifacts', it.value);
      const isOwned = owned.has(kor.replace(/\s/g, ''));
      const local = itemByName(kor);
      const src = local ? `${ASSETS}/icons/${local.id}.png` : slugIcon('artifacts', it.value);
      const magicIcon = local?.magicIcon || (local?.isMagicBook ? `${local.id}_magic.png` : null);
      const magicOverlay = magicIcon
        ? `<img class="magic-overlay" src="${ASSETS}/icons/${magicIcon}" onerror="this.remove()">`
        : '';
      const rarity = local?.rarity ? ` data-rarity="${esc(local.rarity)}"` : '';
      return `<span class="it${isOwned ? ' owned' : ''}" data-cat="artifacts" data-slug="${esc(it.value)}"` +
             `${local ? ` data-id="${local.id}"` : ''}${rarity}>` +
             `<img src="${src}" onerror="this.parentNode.classList.add('missing');this.remove()">${magicOverlay}</span>`;
    }).join('');

    return `<div class="item-section">` +
           `<div class="is-label">${esc(sec.label || '')}</div>` +
           `<div class="icon-row">${icons}</div>` +
           (sec.description ? `<div class="is-desc">${esc(sec.description)}</div>` : '') +
           `</div>`;
  }).join('');

  const headIcons = [
    ['costume', b.costume, '코스튬'],
    ['weapons', b.weapon, '무기'],
    ['miracle', b.miracle, '기적'],
  ].filter(([, slug]) => slug).map(([cat, slug, label]) => {
    // 무기는 3티어(최종) 이름만 보면 어느 계열인지 알 수 없다.
    // 파생 원본인 1티어(기본 무기 6종)를 괄호로 덧붙인다.
    let name = esc(slugName(cat, slug));
    if (cat === 'weapons') {
      const root = weaponRootOf(slug);
      if (root && root !== slug) {
        name += ` <span class="root">(${esc(slugName('weapons', root))})</span>`;
      }
    }
    return `<span class="bd-icon ${cat}" data-cat="${cat}" data-slug="${esc(slug)}"><img src="${slugIcon(cat, slug)}" ` +
      `onerror="this.parentNode.classList.add('missing');this.remove()">` +
      `<em>${name}</em>` +
      `<small>${esc(label)}</small></span>`;
  }).join('');

  view.innerHTML =
    `<div class="bd-head"><button class="back-btn">← 목록으로</button>` +
    `<button class="preset-copy-btn" title="세피리아 게임 표준 프리셋 코드를 클립보드에 복사합니다">📋 프리셋 복사</button>` +
    `<button class="preset-apply-btn" title="인게임 프리셋 슬롯에 이 빌드를 즉시 저장합니다">📥 슬롯에 저장</button>` +
    (buildUrl(b) ? `<button class="open-web-btn" title="위키 원본글을 브라우저로 엽니다">🔗 원본글</button>` : '') +
    `<span class="fav-btn detail${isFav(b) ? ' on' : ''}">${isFav(b) ? '★' : '☆'}</span></div>` +
    `<div class="bd-title-row"><div class="bd-title">${esc(b.title)}</div>` +
    (comboBadges ? `<div class="bd-title-combos">${comboBadges}</div>` : '') +
    `</div>` +
    `<div class="bd-writer">${esc(b.writer?.nickname || '')} · ♥ ${b.postLike ?? 0} · v${esc(b.version || '')}</div>` +
    `<div class="bd-icons">${headIcons}</div>` +
    `<div class="stat-row">${abilities}</div>` +
    (skewer ? `<div class="skewer-row"><span class="skewer-label">🍡 과일꼬치</span>${skewer}</div>` : '') +
    (b.description ? `<div class="bd-desc">${sanitize(b.description)}</div>` : '') +
    sections;

  view.querySelector('.back-btn').addEventListener('click', () => {
    buildDetail = null;
    document.getElementById('build-detail-view').classList.add('hidden');
    document.getElementById('build-list-view').classList.remove('hidden');
    renderBuildList();
  });

  const copyBtn = view.querySelector('.preset-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', guard('preset:copy', () => {
      const code = presetCodec.getOrGeneratePresetCode(b, gamedata);
      if (code) {
        presetCodec.copyPresetCodeToClipboard(code);
        showBuildToast('✔ 프리셋 코드가 클립보드에 복사되었습니다! (인게임 붙여넣기 가능)');
      } else {
        showBuildToast('⚠ 프리셋 코드 생성 실패');
      }
    }));
  }

  const applyBtn = view.querySelector('.preset-apply-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', guard('preset:apply', () => {
      openSlotPickerModal(b);
    }));
  }

  view.querySelector('.fav-btn').addEventListener('click', guard('fav:detail', () => {
    toggleFav(b);
    renderBuildDetail(b);   // 별 모양 갱신
  }));

  const openBtn = view.querySelector('.open-web-btn');
  if (openBtn) {
    openBtn.addEventListener('click', guard('build:open', () => {
      const url = buildUrl(b);
      log.info('builds', '원본글 열기', url);
      shell.openExternal(url);
    }));
  }

  tooltip.resetTooltip();
}

// ── 상세검색 ──────────────────────────────────────────
//
// 위키의 '빌드 검색하기' 다이얼로그와 같은 항목: 작성자/제목 검색어,
// 코스튬·무기·기적·핵심 콤보. 선택기는 아이콘과 함께 보여준다.
// 네이티브 <select> 는 아이콘을 못 넣으므로 직접 그린다 (필드 아래로 펼쳐지는 방식).

/**
 * 선택기 옵션 목록. value 는 API 로 보낼 값.
 *
 * 무기는 두 단으로 나뉜다:
 *  - weapons  = 1티어(무기 종류 6종). 이것만 골라도 충분히 좁혀진다.
 *  - weapon3  = 3티어(최종 무기 102종). 종류를 골랐으면 그 계열만 보여준다.
 */
function pickerOptions(cat) {
  if (cat === 'combo') {
    return combos().map(c => ({
      value: COMBO_TO_WIKI[c.id] || c.id.toLowerCase(),
      name: comboName(c.id),
      icon: comboIcon(c.id),
    }));
  }

  if (cat === 'weapons') {
    return weaponsByTier(1)
      .map(w => ({ value: w.value, name: w.name, icon: slugIcon('weapons', w.value) }));
  }

  if (cat === 'weapon3') {
    const root = pickerSelection.weapons ? pickerSelection.weapons.value : null;
    return weaponsByTier(3)
      .filter(w => !root || weaponRootOf(w.value) === root)
      .map(w => ({ value: w.value, name: w.name, icon: slugIcon('weapons', w.value) }));
  }

  const entries = Object.entries(slugCategories(cat));
  return entries
    .map(([slug, kor]) => ({ value: slug, name: kor, icon: slugIcon(cat, slug) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

const PICKER_PLACEHOLDER = {
  costume: '코스튬 선택', weapons: '무기 종류 선택', weapon3: '세부 무기 선택',
  miracle: '기적 선택', combo: '핵심 콤보 선택',
};

const PICKER_CATS = ['costume', 'weapons', 'weapon3', 'miracle', 'combo'];

// 화면 표시용 선택 상태 (cat -> {value, name, icon} | null)
const pickerSelection = {};

function setupPicker(cat) {
  const btn = document.getElementById(`picker-${cat}`);
  const pop = document.getElementById(`pop-${cat}`);

  btn.addEventListener('click', guard(`picker:${cat}`, () => {
    const wasOpen = !pop.classList.contains('hidden');
    // 다른 선택기는 닫는다
    document.querySelectorAll('.picker-pop').forEach(el => el.classList.add('hidden'));
    if (wasOpen) return;

    renderPickerPop(cat, pop);
    pop.classList.remove('hidden');
  }));
}

function renderPickerPop(cat, pop) {
  const options = pickerOptions(cat);
  pop.innerHTML = '';

  // 항목이 많으면(무기 158종) 이름 필터를 붙인다
  let filterInput = null;
  if (options.length > 30) {
    filterInput = document.createElement('input');
    filterInput.className = 'picker-filter';
    filterInput.placeholder = '이름으로 찾기…';
    pop.appendChild(filterInput);
  }

  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  pop.appendChild(grid);

  const renderTiles = q => {
    grid.innerHTML = '';

    const clear = document.createElement('div');
    clear.className = 'picker-opt clear';
    clear.textContent = '전체 (해제)';
    clear.addEventListener('click', () => selectPickerValue(cat, null));
    grid.appendChild(clear);

    for (const opt of options) {
      if (q && !opt.name.toLowerCase().includes(q)) continue;
      const el = document.createElement('div');
      el.className = 'picker-opt';
      el.innerHTML = `<img src="${opt.icon}" onerror="this.style.visibility='hidden'"><span>${esc(opt.name)}</span>`;
      el.addEventListener('click', () => selectPickerValue(cat, opt));
      grid.appendChild(el);
    }
  };

  renderTiles('');
  if (filterInput) {
    filterInput.addEventListener('input', () => renderTiles(filterInput.value.trim().toLowerCase()));
    filterInput.focus();
  }
}

function selectPickerValue(cat, opt) {
  pickerSelection[cat] = opt;

  // 무기 종류를 바꾸면, 그 계열이 아닌 세부 무기 선택은 무효가 된다
  if (cat === 'weapons') {
    const sub = pickerSelection.weapon3;
    const root = opt ? opt.value : null;
    if (sub && root && weaponRootOf(sub.value) !== root) {
      selectPickerValue('weapon3', null);
    }
  }
  const btn = document.getElementById(`picker-${cat}`);
  if (opt) {
    btn.innerHTML = `<img src="${opt.icon}" onerror="this.remove()"> ${esc(opt.name)}`;
    btn.classList.add('picked');
  } else {
    btn.textContent = PICKER_PLACEHOLDER[cat];
    btn.classList.remove('picked');
  }
  document.getElementById(`pop-${cat}`).classList.add('hidden');
}

function setupAdvSearch() {
  const panel = document.getElementById('adv-search');

  document.getElementById('btn-adv-search').addEventListener('click',
    guard('adv:open', () => panel.classList.remove('hidden')));
  document.getElementById('adv-close').addEventListener('click',
    guard('adv:close', () => panel.classList.add('hidden')));

  for (const cat of PICKER_CATS) setupPicker(cat);

  document.getElementById('adv-reset').addEventListener('click', guard('adv:reset', () => {
    document.getElementById('adv-text').value = '';
    document.getElementById('adv-mode').value = 'writer';
    for (const cat of PICKER_CATS) selectPickerValue(cat, null);
  }));

  document.getElementById('adv-apply').addEventListener('click', guard('adv:apply', () => {
    searchFilters = {
      text: document.getElementById('adv-text').value.trim(),
      isWriter: document.getElementById('adv-mode').value === 'writer',
      costume: pickerSelection.costume ? pickerSelection.costume.value : '',
      // API 의 weapon= 은 티어를 가리지 않는다. 더 구체적인 세부 무기를 우선한다.
      weapon: pickerSelection.weapon3 ? pickerSelection.weapon3.value
            : pickerSelection.weapons ? pickerSelection.weapons.value : '',
      miracle: pickerSelection.miracle ? pickerSelection.miracle.value : '',
      combo: pickerSelection.combo ? pickerSelection.combo.value : '',
    };
    panel.classList.add('hidden');
    buildPage = 1;
    loadBuilds();
    renderActiveFilters();
  }));
}

/** 적용 중인 필터를 목록 위에 아이콘 칩으로 보여준다. ✕ 로 개별 해제. */
function renderActiveFilters() {
  const row = document.getElementById('active-filters');
  row.innerHTML = '';

  const chips = [];
  if (searchFilters.text) {
    chips.push({ key: 'text', label: `${searchFilters.isWriter ? '작성자' : '제목'}: ${searchFilters.text}` });
  }
  const catMap = { costume: 'costume', weapon: 'weapons', miracle: 'miracle', combo: 'combo' };
  for (const [fkey, cat] of Object.entries(catMap)) {
    const v = searchFilters[fkey];
    if (!v) continue;
    // weapon 값은 종류(1티어) 또는 세부 무기(3티어) 중 하나에서 온다
    const sel = fkey === 'weapon'
      ? (pickerSelection.weapon3 && pickerSelection.weapon3.value === v
          ? pickerSelection.weapon3 : pickerSelection.weapons)
      : pickerSelection[cat];
    chips.push({ key: fkey, label: sel ? sel.name : v, icon: sel ? sel.icon : null });
  }

  row.classList.toggle('hidden', chips.length === 0);

  for (const chip of chips) {
    const el = document.createElement('span');
    el.className = 'filter-chip';
    el.innerHTML =
      (chip.icon ? `<img src="${chip.icon}" onerror="this.remove()">` : '') +
      `${esc(chip.label)}<b class="chip-x">✕</b>`;
    el.querySelector('.chip-x').addEventListener('click', guard('chip:remove', () => {
      if (chip.key === 'text') {
        searchFilters.text = '';
      } else if (chip.key === 'weapon') {
        searchFilters.weapon = '';
        selectPickerValue('weapon3', null);
        selectPickerValue('weapons', null);
      } else {
        searchFilters[chip.key] = '';
        selectPickerValue(catMap[chip.key], null);
      }
      buildPage = 1;
      loadBuilds();
      renderActiveFilters();
    }));
    row.appendChild(el);
  }
}

module.exports = { init };
