// Sephiria 공식 프리셋 규격 인코더/디코더 및 위키 빌드 자동 변환기.
//
// 세피리아 게임 엔진(UI_PresetPanel)과 100% 동일한 암호화/압축 규격:
//  - 포맷 버전: AAP1
//  - 압축: GZip (Level 9)
//  - 난독화: XOR (Key: ActionAnimalFarmPresetShareKey)
//  - 인코딩: Base64
//  - 헤더 접두사: AAF_PRESET_OBFZ|v1

'use strict';

const zlib = require('zlib');
const { clipboard } = require('electron');
const { log } = require('./util');

const PRESET_HEADER = 'AAF_PRESET_OBFZ|v1';
const PRESET_XOR_KEY = Buffer.from('ActionAnimalFarmPresetShareKey', 'utf8');

// ── 코스튬 슬러그 -> 인게임 공식 ID 매핑 ────────────────
const COSTUME_SLUG_TO_GAME_ID = {
  pink_rabbit: 'PinkRabbit',
  rabbit: 'Rabbit',
  brown_rabbit: 'BrownRabbit',
  braid: 'BraidRabbit',
  orange_rabbit: 'OrangeRabbit',
  red_rabbit: 'RedRabbit',
  white_rabbit: 'WhiteRabbit',
  wing_ear_rabbit: 'WingEarRabbit',
  red_cat: 'RedCat',
  red_fox: 'RedFox',
  frog: 'Frog',
  mole: 'Mole',
  white_wolf: 'WhiteWolf',
  wizard_rabbit: 'WizardRabbit',
  skeleton: 'Skeleton',
  wings_lost_bat: 'WingsLostBat',
  adventurer: 'Adventurer',
  scholar_lizard: 'ScholarLizard',
  ghost: 'Ghost',
  otter: 'Otter',
  eagle: 'Eagle',
  crocodile: 'Crocodile',
  deer: 'Deer',
  lucky_fairy: 'LuckyFairy',
  squirrel: 'Squirrel',
  turtle: 'Turtle',
  forest_cat: 'ForestCat',
};

// ── 1티어 기본 무기 슬러그 -> 인게임 공식 시작 무기 ID ───
const BASE_WEAPON_SLUG_TO_ID = {
  shield_sword: 0,
  sword_and_shield: 0,
  sword: 0,
  great_sword: 10,
  greatsword: 10,
  dagger: 20,
  crossbow: 100,
  bow: 100,
  katana: 400,
  blade: 400,
  staff: 500,
  polearm: 500,
};

// ── 위키 재능 슬러그 -> 인게임 공식 Passive ID ─────────────
const ABILITY_TO_PASSIVE_ID = {
  anger: 4,      // 분노
  rapid: 5,      // 신속
  survival: 6,   // 생존
  patience: 7,   // 인내
  wisdom: 8,     // 지혜
  will: 9,       // 의지
  greed: 10,     // 탐욕
  ingenuity: 11, // 기지
};

/**
 * AAP1 평문 텍스트를 게임 표준 프리셋 공유 코드로 인코딩
 * @param {string} plainText AAP1 포맷 텍스트
 * @returns {string} AAF_PRESET_OBFZ|v1...
 */
function encodePreset(plainText) {
  if (!plainText || typeof plainText !== 'string') return '';
  try {
    const utf8Buf = Buffer.from(plainText, 'utf8');
    const gzipped = zlib.gzipSync(utf8Buf, { level: 9 });
    const xored = Buffer.alloc(gzipped.length);
    for (let i = 0; i < gzipped.length; i++) {
      xored[i] = gzipped[i] ^ PRESET_XOR_KEY[i % PRESET_XOR_KEY.length];
    }
    return PRESET_HEADER + xored.toString('base64');
  } catch (err) {
    log.error('preset-codec', '인코딩 실패', err.message);
    return '';
  }
}

/**
 * 게임 표준 프리셋 공유 코드를 AAP1 평문 텍스트로 디코딩
 * @param {string} presetCode AAF_PRESET_OBFZ|v1...
 * @returns {string} AAP1 포맷 텍스트
 */
function decodePreset(presetCode) {
  if (!presetCode || typeof presetCode !== 'string') return '';
  const raw = presetCode.trim();
  if (!raw.startsWith(PRESET_HEADER)) {
    log.warn('preset-codec', '유효하지 않은 프리셋 헤더');
    return '';
  }
  try {
    const b64 = raw.slice(PRESET_HEADER.length);
    const xored = Buffer.from(b64, 'base64');
    const gzipped = Buffer.alloc(xored.length);
    for (let i = 0; i < xored.length; i++) {
      gzipped[i] = xored[i] ^ PRESET_XOR_KEY[i % PRESET_XOR_KEY.length];
    }
    const decompressed = zlib.gunzipSync(gzipped);
    return decompressed.toString('utf8');
  } catch (err) {
    log.error('preset-codec', '디코딩 실패', err.message);
    return '';
  }
}

function resolveArtifactId(raw, gamedata) {
  if (!raw) return null;
  if (typeof raw === 'number' && raw > 0) return raw;
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    if (gamedata && typeof gamedata.slugName === 'function' && typeof gamedata.itemByName === 'function') {
      const kor = gamedata.slugName('artifacts', raw);
      const it = gamedata.itemByName(kor || raw);
      if (it && it.id > 0) return it.id;
    }
  } else if (typeof raw === 'object') {
    if (typeof raw.id === 'number' && raw.id > 0) return raw.id;
    const slug = raw.value || raw.slug || raw.name;
    if (slug) {
      if (typeof slug === 'number' && slug > 0) return slug;
      if (gamedata && typeof gamedata.slugName === 'function' && typeof gamedata.itemByName === 'function') {
        const kor = gamedata.slugName('artifacts', slug);
        const it = gamedata.itemByName(kor || slug);
        if (it && it.id > 0) return it.id;
      }
    }
  }
  return null;
}

/**
 * 위키 빌드 JSON 데이터를 분석하여 AAP1 평문 텍스트 생성
 * @param {object} b 위키 빌드 객체
 * @param {object} gamedata 게임 데이터 모듈 (옵션)
 * @returns {string} AAP1 평문 텍스트
 */
function buildPlainFromWikiBuild(b, gamedata) {
  if (!b) return '';

  const lines = ['AAP1'];

  // 1. 시작 무기 ID (W)
  let weaponId = 0;
  if (typeof b.weaponId === 'number') {
    weaponId = b.weaponId;
  } else if (typeof b.weapon === 'number') {
    weaponId = b.weapon;
  } else if (typeof b.weapon === 'string') {
    if (BASE_WEAPON_SLUG_TO_ID[b.weapon] !== undefined) {
      weaponId = BASE_WEAPON_SLUG_TO_ID[b.weapon];
    } else if (gamedata && typeof gamedata.weaponRootOf === 'function') {
      const rootSlug = gamedata.weaponRootOf(b.weapon);
      if (rootSlug && BASE_WEAPON_SLUG_TO_ID[rootSlug] !== undefined) {
        weaponId = BASE_WEAPON_SLUG_TO_ID[rootSlug];
      }
    }
  }
  lines.push(`W:${weaponId || 0}`);

  // 2. 코스튬 ID (C) & 스킨 (S)
  let costumeId = 'PinkRabbit';
  if (b.costume) {
    const rawCostume = String(b.costume).toLowerCase().trim();
    costumeId = COSTUME_SLUG_TO_GAME_ID[rawCostume] || b.costume;
  }
  lines.push(`C:${encodeURIComponent(costumeId)}`);
  lines.push(`S:${encodeURIComponent(b.costumeSkin || b.skin || '')}`);

  // 3. 관심 아티팩트(부적) 목록 (F)
  const artifactIds = new Set();

  // (1) Direct arrays (artifacts, items, required_artifacts)
  const directList = [
    ...(Array.isArray(b.artifacts) ? b.artifacts : []),
    ...(Array.isArray(b.items) ? b.items : []),
    ...(Array.isArray(b.required_artifacts) ? b.required_artifacts : []),
    ...(Array.isArray(b.starting_artifacts) ? b.starting_artifacts : []),
  ];
  for (const art of directList) {
    const id = resolveArtifactId(art, gamedata);
    if (id) artifactIds.add(id);
  }

  // (2) Sections in b.content
  if (Array.isArray(b.content)) {
    for (const sec of b.content) {
      if (sec && Array.isArray(sec.items)) {
        for (const item of sec.items) {
          const id = resolveArtifactId(item, gamedata);
          if (id) artifactIds.add(id);
        }
      }
    }
  }

  if (artifactIds.size > 0) {
    lines.push(`F:${[...artifactIds].join(',')}`);
  }

  // 4. 재능/패시브 포인트 (P)
  const passiveMap = new Map();

  // (1) b.ability object: { will: 20, anger: 20, rapid: 0, ... }
  if (b.ability && typeof b.ability === 'object') {
    for (const [key, val] of Object.entries(b.ability)) {
      const pt = typeof val === 'number' ? val : parseInt(val, 10);
      if (pt > 0 && ABILITY_TO_PASSIVE_ID[key] !== undefined) {
        passiveMap.set(ABILITY_TO_PASSIVE_ID[key], pt);
      }
    }
  }

  // (2) b.passives or b.talents array
  const rawPassives = Array.isArray(b.passives) ? b.passives : (Array.isArray(b.talents) ? b.talents : []);
  for (const p of rawPassives) {
    const id = p.id || p.passiveId || p.key;
    const point = p.point || p.value || p.level || 0;
    if (id && point > 0) {
      passiveMap.set(id, point);
    }
  }

  if (passiveMap.size > 0) {
    const passivePairs = Array.from(passiveMap.entries()).map(([id, pt]) => `${id},${pt}`);
    lines.push(`P:${passivePairs.join(';')}`);
  }

  // 5. 차원 주머니 (D)
  if (Array.isArray(b.dimensionPocket) && b.dimensionPocket.length > 0) {
    const dimList = b.dimensionPocket.map(d => `${d.instanceId || -1},${d.entityId || d.id || -1},${d.quantity || 1}`);
    lines.push(`D:${dimList.join(';')}`);
  }

  // 6. 과일꼬치 적응형 드랍 보너스 (B)
  let dropBonus = 1;
  if (b.fruitSkewerAdaptiveDropBonus != null) {
    dropBonus = b.fruitSkewerAdaptiveDropBonus ? 1 : 0;
  }
  lines.push(`B:${dropBonus}`);

  // 7. 과일꼬치 스탯 (R)
  const fruitPairs = [];
  const rawFruits = b.fruit_skewer || b.fruitSkewer || [];
  if (Array.isArray(rawFruits)) {
    for (const f of rawFruits) {
      const cat = f.key || f.category || f.slug;
      const val = f.value || f.val || 0;
      if (cat && cat !== 'adaptive_drop_bonus' && val !== 0) {
        fruitPairs.push(`${encodeURIComponent(String(cat))},${val}`);
      }
    }
  } else if (rawFruits && typeof rawFruits === 'object') {
    for (const [cat, val] of Object.entries(rawFruits)) {
      if (cat !== 'adaptive_drop_bonus' && val !== 0) {
        fruitPairs.push(`${encodeURIComponent(String(cat))},${val}`);
      }
    }
  }
  if (fruitPairs.length > 0) {
    lines.push(`R:${fruitPairs.join(';')}`);
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * 위키 빌드에서 프리셋 코드를 획득 (있으면 원본 반환, 없으면 즉석 생성)
 * @param {object} b 위키 빌드 객체
 * @param {object} gamedata 게임 데이터 모듈
 * @returns {string} AAF_PRESET_OBFZ|v1...
 */
function getOrGeneratePresetCode(b, gamedata) {
  if (!b) return '';
  if (b.preset_code && typeof b.preset_code === 'string' && b.preset_code.startsWith(PRESET_HEADER)) {
    return b.preset_code.trim();
  }
  if (b.presetCode && typeof b.presetCode === 'string' && b.presetCode.startsWith(PRESET_HEADER)) {
    return b.presetCode.trim();
  }
  const plain = buildPlainFromWikiBuild(b, gamedata);
  return encodePreset(plain);
}

/**
 * 프리셋 코드를 OS 클립보드에 복사
 * @param {string} presetCode
 */
function copyPresetCodeToClipboard(presetCode) {
  if (!presetCode) return false;
  try {
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(presetCode);
      return true;
    }
  } catch {}
  return false;
}

module.exports = {
  PRESET_HEADER,
  COSTUME_SLUG_TO_GAME_ID,
  BASE_WEAPON_SLUG_TO_ID,
  ABILITY_TO_PASSIVE_ID,
  encodePreset,
  decodePreset,
  buildPlainFromWikiBuild,
  getOrGeneratePresetCode,
  copyPresetCodeToClipboard,
};
