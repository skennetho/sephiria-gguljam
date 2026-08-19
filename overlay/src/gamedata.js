// 정적 게임/위키 데이터 접근.
//
// 원천 두 가지:
//  - assets/database.json      플러그인이 게임에서 추출한 아이템 DB (권위 있는 출처)
//  - assets/wiki/*.json        위키에서 수집한 보조 데이터 (한글명·아이콘·효과 설명)
//
// 이 모듈은 로드와 조회만 한다. DOM 을 만지지 않는다.

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./util');
const { locateAssets } = require('../assets-locator');

// assets 위치는 실행 환경마다 다르다:
// 개발(저장소) -> ../assets, 배포판 -> 게임 폴더의 플러그인 덤프 -> 동봉 스냅샷.
const located = locateAssets(path.join(__dirname, '..'), log);
const ASSETS_DIR = located.dir;
// 이미지 src 도 같은 절대경로를 쓴다 (file:// URL)
const ASSETS = 'file:///' + ASSETS_DIR.split(path.sep).join('/');
log.info('assets', `위치 결정: ${located.source}`, ASSETS_DIR);

function readJson(relPath) {
  return JSON.parse(
    fs.readFileSync(path.join(ASSETS_DIR, relPath), 'utf8').replace(/^﻿/, ''));
}

// ── 아이템 DB (게임 추출본) ───────────────────────────

let itemDb = { items: [], combos: [] };
let comboList = [];

function loadItemDb() {
  try {
    itemDb = readJson('database.json');
    comboList = (itemDb.combos || []).filter(c => c.isEnabled !== false);
    log.info('db', '아이템 DB 로드', { 아이템: itemDb.items.length, 콤보: comboList.length });
  } catch (err) {
    log.error('db', 'database.json 로드 실패 — 플러그인이 아직 덤프하지 않았을 수 있음', err.message);
    itemDb = { items: [], combos: [] };
    comboList = [];
  }
}

// ── 위키 슬러그 및 이름 매핑 ──────────────────────────

const NAME_ALIASES = {
  '엔도디토의문진': '엔도디트의문진',
  '차크람': '전격차크람',
  '플라즈마헬맷': '플라즈마헬멧',
  '변환의서:화염': '변환의서:<tag=TEXT:Elemental_Fire>',
  '변환의서:얼음': '변환의서:<tag=TEXT:Elemental_Ice>',
  '변환의서:번개': '변환의서:<tag=TEXT:Elemental_Lightning>',
};

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .replace(/<tag=TEXT:Elemental_Fire>/gi, '화염')
    .replace(/<tag=TEXT:Elemental_Ice>/gi, '얼음')
    .replace(/<tag=TEXT:Elemental_Lightning>/gi, '번개');
}

function itemById(id) {
  const it = itemDb.items.find(i => i.id === id);
  if (!it) return null;
  return { ...it, displayName: normalizeName(it.name) };
}

/** 한글명(공백 무시)으로 게임 DB 아이템 찾기 — 위키 슬러그와의 매칭에 쓴다 */
function itemByName(kor) {
  let target = String(kor || '').replace(/\s/g, '');
  if (!target) return null;
  if (NAME_ALIASES[target]) target = NAME_ALIASES[target];

  const it = itemDb.items.find(i => {
    const dbName = (i.name || '').replace(/\s/g, '');
    return dbName === target || normalizeName(dbName).replace(/\s/g, '') === target;
  });
  if (!it) return null;
  return { ...it, displayName: normalizeName(it.name) };
}

function comboById(id) {
  return comboList.find(c => c.id === id) || null;
}

function combos() {
  return comboList;
}

// ── 콤보 및 시너지 ─────────────────────────────────────

const COMBO_KOREAN_NAMES = {
  EMBER: '잉걸불',
  FROST: '얼음무구',
  GLACIER: '빙하',
  MAGITECH: '마법공학',
  SHADOW: '그림자',
  GUARDIAN: '수호',
  WINDSONG: '바람노래',
  MYSTIC: '신비',
  PLANET: '행성',
  COMPANION: '동료',
  PRECISION: '정밀',
  DARKCLOUD: '먹구름',
  STURDY: '견고',
  LAKE: '호수',
  FLAMESWORD: '태양검',
  ACADEMY: '아카데미',
  CURSE: '저주',
  SAVVY: '교섭',
  ELEMENTAL: '원소',
  ALCHEMY: '연금술',
  PARTY: '파티',
  WEAPON: '대장간',
};

// ── 위키 슬러그 매핑 ──────────────────────────────────

// 슬러그 -> 한글명 (assets/wiki/slugs.json)
let slugMap = null;
try { slugMap = readJson(path.join('wiki', 'slugs.json')); } catch { /* 없으면 슬러그 그대로 표시 */ }

// 위키 콤보 슬러그 -> 로컬 아이콘 키
const WIKI_COMBO_KEY = {
  yinggalbul: 'EMBER', ice_weapon: 'FROST', glacier: 'GLACIER',
  magic_engineering: 'MAGITECH', shadow: 'SHADOW', guardian: 'GUARDIAN',
  spring_song: 'WINDSONG', mystery: 'MYSTIC', planet: 'PLANET',
  colleague: 'COMPANION', precision: 'PRECISION', extrium: 'DARKCLOUD',
  firmness: 'STURDY', lake: 'LAKE', sun_sword: 'FLAMESWORD',
  academy: 'ACADEMY', curse: 'CURSE', bargaining: 'SAVVY',
  element: 'ELEMENTAL', alchemy: 'ALCHEMY', party: 'PARTY', weapon: 'WEAPON'
};

// 핵심 콤보 API 값은 위키 슬러그다. 우리 콤보 id(아이콘 키) -> 위키 슬러그 역매핑.
const COMBO_TO_WIKI = Object.fromEntries(
  Object.entries(WIKI_COMBO_KEY).map(([slug, key]) => [key, slug]));

function comboKeyFromWikiSlug(slug) {
  if (!slug) return '';
  const lower = String(slug).toLowerCase().trim();
  return WIKI_COMBO_KEY[lower] || String(slug).toUpperCase();
}

/**
 * 콤보의 ID, 한글명, 아이콘 경로를 일관되게 추출하는 중앙 함수
 * 슬러그(yinggalbul), ID(EMBER), 한글명(잉걸불) 모두 지원
 */
function comboInfo(keyOrSlug) {
  if (!keyOrSlug) return null;
  const raw = String(keyOrSlug).trim();
  const lower = raw.toLowerCase();

  let key = WIKI_COMBO_KEY[lower];
  if (!key) {
    const upper = raw.toUpperCase();
    if (COMBO_KOREAN_NAMES[upper] || comboById(upper)) {
      key = upper;
    }
  }
  if (!key) {
    for (const [k, kor] of Object.entries(COMBO_KOREAN_NAMES)) {
      if (kor === raw || kor === lower) {
        key = k;
        break;
      }
    }
  }
  if (!key) key = raw.toUpperCase();

  const c = comboById(key);
  const name = (c && c.name) || COMBO_KOREAN_NAMES[key] || raw;
  const icon = `${ASSETS}/combos/${key}.png`;
  const wikiSlug = COMBO_TO_WIKI[key] || lower;

  return {
    id: key,
    name,
    icon,
    wikiSlug,
    combo: c
  };
}

function comboName(keyOrSlug) {
  const info = comboInfo(keyOrSlug);
  return info ? info.name : String(keyOrSlug || '');
}

function comboIcon(keyOrSlug) {
  const info = comboInfo(keyOrSlug);
  return info ? info.icon : `${ASSETS}/combos/${keyOrSlug}.png`;
}

/**
 * 콤보 뱃지(아이콘 + 한글명 필수) 공통 렌더링 함수
 */
function renderComboBadge(keyOrSlug, options = {}) {
  const info = comboInfo(keyOrSlug);
  if (!info) return '';
  const cls = options.className || 'combo-badge';
  const showName = options.showName !== false;
  const countStr = options.count != null && options.count !== '' ? ` <b class="cb-count">${options.count}</b>` : '';
  const extra = options.extraHtml || '';

  return `<span class="${cls}" data-combo="${info.id}">` +
         `<img src="${info.icon}" alt="${info.name}" onerror="this.style.visibility='hidden'">` +
         (showName ? `<span class="combo-name">${info.name}</span>` : '') +
         countStr +
         extra +
         `</span>`;
}

function slugName(category, slug) {
  if (!slug) return '';
  return slugMap?.[category]?.[slug] || slug;
}

function slugCategories(category) {
  return (slugMap && slugMap[category]) || {};
}

// 슬러그 -> 로컬 아이콘 경로 (assets/wiki/icons/<카테고리>/<슬러그>.png)
let wikiData = null;
try { wikiData = readJson(path.join('wiki', 'wikidata.json')).data; } catch { wikiData = null; }

let wikiIcons = null;
try {
  const wd = wikiData || {};
  wikiIcons = {};
  for (const [cat, items] of Object.entries(wd)) {
    wikiIcons[cat] = {};
    for (const rec of Object.values(items)) {
      if (rec.localIcon) wikiIcons[cat][rec.value] = `${ASSETS}/wiki/icons/${rec.localIcon}`;
    }
  }
} catch {
  wikiIcons = null;
}

/** 위키 카테고리 아이콘. 로컬에 없으면 CDN 으로 폴백한다. */
function slugIcon(category, slug) {
  if (!slug) return null;
  const local = wikiIcons && wikiIcons[category] && wikiIcons[category][slug];
  if (local) return local;
  const rec = wikiData && wikiData[category] && wikiData[category][slug];
  if (rec && rec.image) return rec.image;
  return `https://img.sephiria.wiki/${category}/${slug}.png`;
}

// ── 무기 티어 ─────────────────────────────────────────

const weaponRecords = (wikiData && wikiData.weapons) || {};

function weaponsByTier(tier) {
  return Object.values(weaponRecords)
    .filter(w => w.tier === tier)
    .map(w => ({ value: w.value, name: w.label_kor, parent: w.parent }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 3티어 무기의 1티어(종류) 슬러그. 체인이 끊겼으면 null. */
function weaponRootOf(slug) {
  let cur = weaponRecords[slug];
  let hops = 0;
  while (cur && cur.tier !== 1 && hops++ < 5) cur = weaponRecords[cur.parent];
  return cur && cur.tier === 1 ? cur.value : null;
}

function weaponByName(kor) {
  const target = String(kor || '').replace(/\s/g, '');
  if (!target) return null;
  for (const w of Object.values(weaponRecords)) {
    if ((w.label_kor || w.value_kor || '').replace(/\s/g, '') === target) return w;
  }
  return null;
}

function costumeByName(kor) {
  const target = String(kor || '').replace(/\s/g, '');
  if (!target) return null;
  for (const c of Object.values((wikiData && wikiData.costume) || {})) {
    if ((c.label_kor || '').replace(/\s/g, '') === target) return c;
  }
  return null;
}

// ── 과일꼬치 ──────────────────────────────────────────

const SKEWER_SPECIAL = {
  adaptive_drop_bonus: { name: '적응형 드롭 보너스', icon: 'special/adaptive_drop_bonus.png' },
};

function skewerName(key) {
  const special = SKEWER_SPECIAL[key];
  if (special) return special.name;
  return comboName(key);
}

function skewerIcon(key) {
  const special = SKEWER_SPECIAL[key];
  if (special) return `${ASSETS}/wiki/icons/${special.icon}`;
  return comboIcon(key);
}

// ── 엔티티 상세 (툴팁용: 아티팩트·무기·코스튬·기적) ─────────────

/** 범용 엔티티 정보 (아티팩트/무기/코스튬/기적) */
function entityInfo(category, slug, id, name) {
  let cat = category || 'artifacts';

  // 이름만 넘어왔을 때 슬러그 유추
  if (!slug && name) {
    if (cat === 'weapons') {
      const w = weaponByName(name);
      if (w) slug = w.value;
    } else if (cat === 'costume') {
      const c = costumeByName(name);
      if (c) slug = c.value;
    } else if (cat === 'artifacts') {
      const g = itemByName(name);
      if (g) id = g.id;
    }
  }

  if (cat === 'artifacts') {
    const w = (wikiData && wikiData.artifacts && wikiData.artifacts[slug]) || null;
    const g = id != null ? itemById(Number(id)) : (slug ? itemByName(slugName('artifacts', slug)) : null);
    return { category: 'artifacts', slug, wiki: w, game: g };
  }

  if (cat === 'weapons') {
    const w = (wikiData && wikiData.weapons && wikiData.weapons[slug]) || (name ? weaponByName(name) : null);
    return { category: 'weapons', slug: slug || (w && w.value), wiki: w, game: null };
  }

  if (cat === 'costume') {
    const c = (wikiData && wikiData.costume && wikiData.costume[slug]) || (name ? costumeByName(name) : null);
    return { category: 'costume', slug: slug || (c && c.value), wiki: c, game: null };
  }

  if (cat === 'miracle') {
    const m = (wikiData && wikiData.miracle && wikiData.miracle[slug]) || null;
    return { category: 'miracle', slug, wiki: m, game: null };
  }

  return { category: cat, slug, wiki: null, game: null };
}

function artifactInfo(slug, id) {
  if (wikiArtifacts === null) {
    try {
      wikiArtifacts = readJson(path.join('wiki', 'wikidata.json')).data.artifacts || {};
    } catch { wikiArtifacts = {}; }
  }
  const w = wikiArtifacts[slug] || null;
  const g = id != null ? itemById(Number(id)) : null;
  return { wiki: w, game: g };
}

// ── 기타 상수 ─────────────────────────────────────────

const RARITY_RANK = { Common: 0, Uncommon: 1, Rare: 2, Unique: 3, Epic: 3, Legend: 4 };

// 실제 세피리아 인게임 6대 재능 (기본 제거)
const ABILITY_LABELS = {
  will: '의지', anger: '분노', rapid: '신속',
  wisdom: '지혜', patience: '인내', survival: '생존'
};

module.exports = {
  ASSETS, ASSETS_DIR, readJson,
  loadItemDb, itemById, itemByName, comboById, combos,
  COMBO_KOREAN_NAMES, comboInfo, comboName, comboIcon, renderComboBadge,
  WIKI_COMBO_KEY, COMBO_TO_WIKI, comboKeyFromWikiSlug,
  slugName, slugIcon, slugCategories,
  weaponsByTier, weaponRootOf, weaponByName, costumeByName,
  skewerName, skewerIcon,
  entityInfo, artifactInfo,
  RARITY_RANK, ABILITY_LABELS,
};
