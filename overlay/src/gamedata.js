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

function itemById(id) {
  return itemDb.items.find(i => i.id === id) || null;
}

/** 한글명(공백 무시)으로 게임 DB 아이템 찾기 — 위키 슬러그와의 매칭에 쓴다 */
function itemByName(kor) {
  const target = String(kor || '').replace(/\s/g, '');
  if (!target) return null;
  return itemDb.items.find(i => (i.name || '').replace(/\s/g, '') === target) || null;
}

function comboById(id) {
  return comboList.find(c => c.id === id) || null;
}

function combos() {
  return comboList;
}

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
  element: 'ELEMENTAL', alchemy: 'ALCHEMY'
};

// 핵심 콤보 API 값은 위키 슬러그다. 우리 콤보 id(아이콘 키) -> 위키 슬러그 역매핑.
const COMBO_TO_WIKI = Object.fromEntries(
  Object.entries(WIKI_COMBO_KEY).map(([slug, key]) => [key, slug]));

function comboKeyFromWikiSlug(slug) {
  return WIKI_COMBO_KEY[slug] || String(slug || '').toUpperCase();
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
  return `https://img.sephiria.wiki/${category}/${slug}.png`;
}

// ── 무기 티어 ─────────────────────────────────────────
//
// 위키 무기는 3단 트리다: 1티어(무기 종류 6종) -> 2티어(50) -> 3티어(최종 102).
// 검색 UI 는 두 단만 노출한다 — 종류(1티어)로 넓게 고르고, 필요하면
// 세부 무기(3티어)로 좁힌다. 2티어는 중간 단계라 사용자에게 보여주지 않고
// 부모 체인을 거슬러 올라갈 때만 쓴다. (실측: 3티어 102개 전부 체인 정상)
// API 의 weapon= 은 1·2·3티어 슬러그를 모두 받는다.

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

// ── 과일꼬치 ──────────────────────────────────────────
//
// key 는 대부분 콤보 슬러그지만, 콤보가 아닌 특수 항목도 섞여 있다.
// adaptive_drop_bonus 는 게임의 과일꼬치 패널에 있는 '적응형 드롭 보너스' 토글이다
// (Assembly-CSharp 의 UI_FruitSkewerPanel 에 [Header("Adaptive Item Drop Bonus")]).
// 위키 빌드 50개 기준 가장 많이 쓰이는 항목이라 반드시 이름을 붙여야 한다.

const SKEWER_SPECIAL = {
  adaptive_drop_bonus: { name: '적응형 드롭 보너스', icon: 'special/adaptive_drop_bonus.png' },
};

function skewerName(key) {
  const special = SKEWER_SPECIAL[key];
  if (special) return special.name;
  const combo = comboById(comboKeyFromWikiSlug(key));
  return (combo && combo.name) || key;
}

function skewerIcon(key) {
  const special = SKEWER_SPECIAL[key];
  if (special) return `${ASSETS}/wiki/icons/${special.icon}`;
  const combo = comboById(comboKeyFromWikiSlug(key));
  return combo ? `${ASSETS}/combos/${combo.id}.png` : null;
}

// ── 위키 아티팩트 상세 (툴팁용) ───────────────────────

let wikiArtifacts = null;

/** 위키 아티팩트 레코드 (효과 설명·등급·콤보 소속) + 게임 DB 레코드 */
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

const ABILITY_LABELS = {
  base: '기본', will: '의지', anger: '분노', rapid: '신속',
  wisdom: '지혜', patience: '인내', survival: '생존'
};

module.exports = {
  ASSETS, ASSETS_DIR, readJson,
  loadItemDb, itemById, itemByName, comboById, combos,
  WIKI_COMBO_KEY, COMBO_TO_WIKI, comboKeyFromWikiSlug,
  slugName, slugIcon, slugCategories,
  weaponsByTier, weaponRootOf,
  skewerName, skewerIcon,
  artifactInfo,
  RARITY_RANK, ABILITY_LABELS,
};
