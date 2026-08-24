// Sephiria 다국어 (i18n) 시스템 — 한국어(ko) / 영어(en)
//
// 모든 UI 텍스트, 뱃지, 툴팁, 콤보 및 재능 명칭을 중앙에서 관리한다.
// 추후 일본어(ja), 중국어(zh) 등 추가 언어 확장이 용이한 구조로 설계됨.

'use strict';

const STORAGE_KEY = 'sephiria.language';
let currentLang = 'ko';

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'ko') {
    currentLang = saved;
  }
} catch {}

const listeners = new Set();

// ── 콤보 다국어 사전 ──────────────────────────────────
const COMBOS = {
  ko: {
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
  },
  en: {
    EMBER: 'Ember',
    FROST: 'Frost Relic',
    GLACIER: 'Glacier',
    MAGITECH: 'Magitech',
    SHADOW: 'Shadow',
    GUARDIAN: 'Guardian',
    WINDSONG: 'Wind Song',
    MYSTIC: 'Mystic',
    PLANET: 'Planet',
    COMPANION: 'Companion',
    PRECISION: 'Precision',
    DARKCLOUD: 'Storm Cloud',
    STURDY: 'Sturdy',
    LAKE: 'Lake',
    FLAMESWORD: 'Solar Blade',
    ACADEMY: 'Academy',
    CURSE: 'Curse',
    SAVVY: 'Negotiation',
    ELEMENTAL: 'Elemental',
    ALCHEMY: 'Alchemy',
    PARTY: 'Party',
    WEAPON: 'Forge',
  }
};

// ── 6대 재능 (Talents) ────────────────────────────────
const ABILITIES = {
  ko: {
    will: '의지',
    anger: '분노',
    rapid: '신속',
    wisdom: '지혜',
    patience: '인내',
    survival: '생존',
    greed: '탐욕',
    ingenuity: '기지',
  },
  en: {
    will: 'Will',
    anger: 'Anger',
    rapid: 'Swiftness',
    wisdom: 'Wisdom',
    patience: 'Patience',
    survival: 'Survival',
    greed: 'Greed',
    ingenuity: 'Ingenuity',
  }
};

// ── 희귀도 ────────────────────────────────────────────
const RARITIES = {
  ko: {
    Common: '일반',
    Uncommon: '고급',
    Rare: '희귀',
    Unique: '영웅',
    Epic: '영웅',
    Legend: '전설',
    Eternal: '신화',
  },
  en: {
    Common: 'Common',
    Uncommon: 'Uncommon',
    Rare: 'Rare',
    Unique: 'Epic',
    Epic: 'Epic',
    Legend: 'Legendary',
    Eternal: 'Mythic',
  }
};

// ── UI 번역 사전 ──────────────────────────────────────
const TRANSLATIONS = {
  ko: {
    // 패널 타이틀 및 힌트
    'panel.optimizer': '⚡ 최적배치',
    'panel.builds': '📖 위키 빌드',
    'panel.team': '👥 팀원 빌드',
    'panel.dragHint': '드래그로 이동',
    'panel.close': '닫기',

    // 단축키 바
    'hotkey.optimizer': '<b>Ctrl+D</b> ⚡ 최적배치',
    'hotkey.builds': '<b>Ctrl+B</b> 📖 빌드',
    'hotkey.team': '<b>F1</b> 👥 팀원',
    'hotkey.hide': '<b>Ctrl+H</b> 숨기기',
    'lang.toggle': '🌐 한국어 / EN',

    // 최적배치 패널
    'opt.title': '⚡ 참 최적배치',
    'opt.priorityHeader': '콤보 우선순위',
    'opt.priorityDesc': '드래그해서 원하는 콤보 순서를 조정하세요.',
    'opt.addCombo': '+ 콤보 추가',
    'opt.calc': '▶ 계산',
    'opt.recalc': '↻ 다시 계산',
    'opt.calculating': '계산 중…',
    'opt.refresh': '⟳ 새로고침',
    'opt.apply': '✔ 반영',
    'opt.undo': '⤺ 되돌리기',
    'opt.viewCurrent': '현재 인벤토리',
    'opt.viewOptimized': '계산 결과',
    'opt.captionCurrent': '실시간 · 노란 숫자 = 현재 강화수',
    'opt.captionOptimized': '아이콘 = 목표 위치 · 노란 숫자 = 최종 강화수',
    'opt.empty': '게임에서 인벤토리를 열면 자동으로 표시됩니다',
    'opt.neverCalc': '계산한 적 없음',
    'opt.alreadyOptimal': '이미 최적입니다',
    'opt.movesCount': '{moves}개 이동',

    // 빌드 패널
    'builds.tabAll': '전체 빌드',
    'builds.tabFav': '즐겨찾기',
    'builds.sortLatest': '최신순',
    'builds.sortPopular': '인기순',
    'builds.latestPatchOnly': '최신 패치만',
    'builds.detailSearch': '상세검색',
    'builds.empty': '결과가 없습니다',
    'builds.favEmpty': '즐겨찾기한 빌드가 없습니다<br><small>카드의 ☆ 를 눌러 추가하세요</small>',
    'builds.copyBtn': '📋 프리셋 복사',
    'builds.saveBtn': '📥 슬롯에 저장',
    'builds.backBtn': '← 목록으로',
    'builds.originalLink': '🔗 원본글',
    'builds.skewerLabel': '🍡 과일꼬치',
    'builds.searchPlaceholder': '작성자 검색 (체크 해제 시 제목)',

    // 슬롯 모달
    'psm.title': '📥 저장할 인게임 프리셋 슬롯 선택',
    'psm.targetBuild': '대상 빌드:',
    'psm.desc': '선택한 슬롯에 이 빌드의 코스튬·무기·관심부적·재능·과일꼬치가 저장됩니다.',
    'psm.loading': '인게임 슬롯 목록 불러오는 중…',
    'psm.newSlot': '➕ 새 슬롯 (슬롯 {slot}) 추가 후 저장',
    'psm.slotNum': '슬롯 {slot}',
    'psm.currentSelected': '현재 적용됨',
    'psm.saved': '저장됨',
    'psm.emptySlot': '빈 슬롯',

    // 팀원 패널
    'team.empty': '멀티플레이 중이 아니거나<br>팀원 정보가 아직 없습니다',
    'team.weapon': '무기',
    'team.costume': '캐릭터',
    'team.miracle': '기적',

    // 툴팁 공통
    'tt.weapon': '무기',
    'tt.tier': '{tier}티어',
    'tt.tier1Base': '1티어 기본 무기',
    'tt.tier2': '2티어',
    'tt.tier3': '3티어',
    'tt.costume': '코스튬',
    'tt.miracle': '기적',
    'tt.artifact': '아티팩트',
    'tt.comboSynergy': '콤보 시너지',
    'tt.owned': '보유 중',
    'tt.inactive': '조건 미달(비활성)',
    'tt.condition': '⚠️ 발동 조건:',
    'tt.unlock': '해금:',
    'tt.setRequirement': '({count}세트)',
    'tt.ownedCount': '{count}개 보유',
    'tt.tier2InheritedEffect': '[2티어 {name} 효과]',
    'tt.tier3UniqueEffect': '[3티어 고유 효과]',
    'tt.tier2Effect': '[2티어 효과]',

    // 설정 패널
    'panel.settings': '⚙️ 설정',
    'hotkey.settings': '<b>Ctrl+,</b> ⚙️ 설정',
    'settings.info': '📋 정보',
    'settings.version': '현재 버전',
    'settings.github': 'GitHub 페이지',
    'settings.update': '🔄 업데이트',
    'settings.checkUpdate': '업데이트 확인',
    'settings.checking': '확인 중…',
    'settings.downloading': '다운로드 중… ({percent}%)',
    'settings.upToDate': '✅ 최신 버전입니다 (v{version})',
    'settings.available': '🔔 새 버전 v{version} 사용 가능',
    'settings.patchReady': '지금 적용 시 오버레이만 재시작됩니다 (게임 유지)',
    'settings.majorReady': '게임 재시작 시 자동 적용됩니다',
    'settings.applyNow': '지금 적용',
    'settings.applying': '적용 중…',
    'settings.staged': '⏳ v{version} 대기 중 — 게임 종료 시 자동 적용',
    'settings.downloadFail': '❌ 다운로드 실패',
    'settings.checkFail': '❌ 확인 실패 (네트워크 오류)',
    'settings.preferences': '🌐 환경설정',
    'settings.language': '언어',
  },
  en: {
    // Panel Titles & Hints
    'panel.optimizer': '⚡ Optimizer',
    'panel.builds': '📖 Wiki Builds',
    'panel.team': '👥 Teammates',
    'panel.dragHint': 'Drag to move',
    'panel.close': 'Close',

    // Hotkey Bar
    'hotkey.optimizer': '<b>Ctrl+D</b> ⚡ Optimizer',
    'hotkey.builds': '<b>Ctrl+B</b> 📖 Builds',
    'hotkey.team': '<b>F1</b> 👥 Team',
    'hotkey.hide': '<b>Ctrl+H</b> Hide',
    'lang.toggle': '🌐 English / 한국어',

    // Optimizer Panel
    'opt.title': '⚡ Charm Placement Optimizer',
    'opt.priorityHeader': 'Combo Priority',
    'opt.priorityDesc': 'Drag and reorder your preferred combo synergies.',
    'opt.addCombo': '+ Add Combo',
    'opt.calc': '▶ Calculate',
    'opt.recalc': '↻ Recalculate',
    'opt.calculating': 'Calculating…',
    'opt.refresh': '⟳ Refresh',
    'opt.apply': '✔ Apply',
    'opt.undo': '⤺ Undo',
    'opt.viewCurrent': 'Current Layout',
    'opt.viewOptimized': 'Optimized Layout',
    'opt.captionCurrent': 'Live · Yellow Number = Current Level',
    'opt.captionOptimized': 'Target Slot · Yellow Number = Enhanced Level',
    'opt.empty': 'Open in-game inventory to load grid automatically',
    'opt.neverCalc': 'Not calculated yet',
    'opt.alreadyOptimal': 'Already optimal',
    'opt.movesCount': '{moves} moves',

    // Builds Panel
    'builds.tabAll': 'All Builds',
    'builds.tabFav': 'Favorites',
    'builds.sortLatest': 'Latest',
    'builds.sortPopular': 'Popular',
    'builds.latestPatchOnly': 'Latest Patch Only',
    'builds.detailSearch': 'Filter Search',
    'builds.empty': 'No builds found',
    'builds.favEmpty': 'No favorites saved<br><small>Click ☆ on a build card to favorite</small>',
    'builds.copyBtn': '📋 Copy Preset',
    'builds.saveBtn': '📥 Save to Slot',
    'builds.backBtn': '← Back to List',
    'builds.originalLink': '🔗 View on Wiki',
    'builds.skewerLabel': '🍡 Fruit Skewer',
    'builds.searchPlaceholder': 'Search Author (or title if unchecked)',

    // Slot Modal
    'psm.title': '📥 Select In-Game Preset Slot',
    'psm.targetBuild': 'Target Build:',
    'psm.desc': 'Saves costume, weapon, favorite charms, talents, and fruit skewers to this slot.',
    'psm.loading': 'Fetching in-game slots…',
    'psm.newSlot': '➕ Create & Save into Slot {slot}',
    'psm.slotNum': 'Slot {slot}',
    'psm.currentSelected': 'Currently Active',
    'psm.saved': 'Saved',
    'psm.emptySlot': 'Empty Slot',

    // Team Panel
    'team.empty': 'Not in multiplayer or no teammates found',
    'team.weapon': 'Weapon',
    'team.costume': 'Costume',
    'team.miracle': 'Miracle',

    // Tooltips
    'tt.weapon': 'Weapon',
    'tt.tier': 'Tier {tier}',
    'tt.tier1Base': 'Tier 1 Base Weapon',
    'tt.tier2': 'Tier 2',
    'tt.tier3': 'Tier 3',
    'tt.costume': 'Costume',
    'tt.miracle': 'Miracle',
    'tt.artifact': 'Artifact',
    'tt.comboSynergy': 'Combo Synergy',
    'tt.owned': 'Owned',
    'tt.inactive': 'Inactive (Criteria not met)',
    'tt.condition': '⚠️ Activation Criteria:',
    'tt.unlock': 'Unlock:',
    'tt.setRequirement': '({count} Set)',
    'tt.ownedCount': '{count} Owned',
    'tt.tier2InheritedEffect': '[Tier 2 {name} Effect]',
    'tt.tier3UniqueEffect': '[Tier 3 Unique Effect]',
    'tt.tier2Effect': '[Tier 2 Effect]',

    // Settings Panel
    'panel.settings': '⚙️ Settings',
    'hotkey.settings': '<b>Ctrl+,</b> ⚙️ Settings',
    'settings.info': '📋 Info',
    'settings.version': 'Current Version',
    'settings.github': 'GitHub Page',
    'settings.update': '🔄 Update',
    'settings.checkUpdate': 'Check for Updates',
    'settings.checking': 'Checking…',
    'settings.downloading': 'Downloading… ({percent}%)',
    'settings.upToDate': '✅ Up to date (v{version})',
    'settings.available': '🔔 New version v{version} available',
    'settings.patchReady': 'Overlay will restart to apply (game keeps running)',
    'settings.majorReady': 'Will be applied when game exits',
    'settings.applyNow': 'Apply Now',
    'settings.applying': 'Applying…',
    'settings.staged': '⏳ v{version} staged — auto-applies on game exit',
    'settings.downloadFail': '❌ Download failed',
    'settings.checkFail': '❌ Check failed (network error)',
    'settings.preferences': '🌐 Preferences',
    'settings.language': 'Language',
  }
};

// ── 위키 콤보 슬러그 매핑 ──────────────────────────────
const WIKI_COMBO_SLUGS = {
  yinggalbul: 'EMBER', ice_weapon: 'FROST', glacier: 'GLACIER',
  magic_engineering: 'MAGITECH', shadow: 'SHADOW', guardian: 'GUARDIAN',
  spring_song: 'WINDSONG', mystery: 'MYSTIC', planet: 'PLANET',
  colleague: 'COMPANION', precision: 'PRECISION', extrium: 'DARKCLOUD',
  firmness: 'STURDY', lake: 'LAKE', sun_sword: 'FLAMESWORD',
  academy: 'ACADEMY', curse: 'CURSE', bargaining: 'SAVVY',
  element: 'ELEMENTAL', alchemy: 'ALCHEMY', party: 'PARTY', weapon: 'WEAPON'
};

function getLanguage() {
  return currentLang;
}

function setLanguage(lang) {
  if (lang !== 'ko' && lang !== 'en') return;
  if (currentLang === lang) return;
  currentLang = lang;
  try { localStorage.setItem(STORAGE_KEY, currentLang); } catch {}
  for (const fn of listeners) {
    try { fn(currentLang); } catch {}
  }
}

function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function t(key, params = {}) {
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.ko;
  let str = dict[key] || TRANSLATIONS.ko[key] || key;
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

/**
 * 콤보 한글/영문 이름 반환 (기본값 한국어)
 */
function comboName(keyOrSlug, forceLang = null) {
  if (!keyOrSlug) return '';
  const lang = forceLang || currentLang || 'ko';
  const raw = String(keyOrSlug).trim();
  const lower = raw.toLowerCase();
  const key = WIKI_COMBO_SLUGS[lower] || raw.toUpperCase();

  // 1. 키 매핑
  if (COMBOS[lang]?.[key]) return COMBOS[lang][key];
  if (COMBOS.ko[key]) return COMBOS.ko[key];

  // 2. 역추적
  for (const [k, v] of Object.entries(COMBOS.ko)) {
    if (v === raw || k.toLowerCase() === lower) {
      return COMBOS[lang]?.[k] || v;
    }
  }

  return COMBOS.ko[key] || raw;
}

/**
 * 재능 한글/영문 이름 반환
 */
function abilityName(key, forceLang = null) {
  const lang = forceLang || currentLang || 'ko';
  const k = String(key || '').toLowerCase();
  return ABILITIES[lang]?.[k] || ABILITIES.ko[k] || key;
}

/**
 * 희귀도 한글/영문 이름 반환
 */
function rarityName(rawRarity, forceLang = null) {
  if (!rawRarity) return '';
  const lang = forceLang || currentLang || 'ko';
  const key = String(rawRarity).trim();
  const formatted = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  return RARITIES[lang]?.[formatted] || RARITIES[lang]?.[key] || RARITIES.ko[formatted] || key;
}

module.exports = {
  getLanguage,
  setLanguage,
  onLanguageChange,
  t,
  comboName,
  abilityName,
  rarityName,
  COMBOS,
  ABILITIES,
  RARITIES,
  TRANSLATIONS,
};
