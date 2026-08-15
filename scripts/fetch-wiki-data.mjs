#!/usr/bin/env node
// sephiria.wiki 에서 아티팩트/석판/무기/기적/코스튬/재능 데이터를 수집해 assets/wiki/ 에 저장한다.
//
// 위키는 Next.js App Router 라 페이지 HTML 자체에는 <img> 가 없고,
// self.__next_f.push([1,"...")] 형태의 RSC flight 페이로드 안에 JSON 이 이스케이프되어 들어있다.
// 그 페이로드를 복원해 아이템 레코드를 뽑아낸다.
//
// 레코드 예시:
//   { id, value: "windpool_shawl", label_kor: "바람풀 목도리", tier: "common",
//     effect: { sets: ["spring_song"], content: "[고유] 대시 공격 피해 +30/45/60/80%" },
//     image: "https://img.sephiria.wiki/artifacts/windpool_shawl.png", level: 3 }
//
// effect.sets = 콤보 소속, effect.content 의 "a/b/c/d" = 강화 단계별 수치.
// 둘 다 배치 최적화 목적함수에 필요하다.
//
// 사용법:  node scripts/fetch-wiki-data.mjs
// 결과물:  assets/wiki/wikidata.json

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'wiki');

// 위키가 봇 UA 를 403 처리하므로 브라우저 UA 를 쓴다
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PAGES = ['/artifact', '/stone', '/weapon', '/miracle', '/costume', '/talent', '/combo'];

async function fetchPage(path) {
  const res = await fetch('https://www.sephiria.wiki' + path, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * self.__next_f.push([1,"<문자열>"]) 안의 문자열들을 복원해 하나로 잇는다.
 * 각 조각은 JS 문자열 리터럴이므로 JSON.parse 로 이스케이프를 한 겹 벗긴다.
 */
function decodeFlight(html) {
  const parts = [];
  // push([1,"..."]) 의 큰따옴표 문자열 리터럴을 통째로 잡는다 (이스케이프된 따옴표 허용)
  const re = /self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")/g;
  for (const m of html.matchAll(re)) {
    try {
      parts.push(JSON.parse(m[1]));
    } catch {
      /* 조각 하나가 깨져도 나머지는 살린다 */
    }
  }
  return parts.join('');
}

/**
 * 문자열 pos 위치의 '{' 부터 짝이 맞는 '}' 까지 잘라낸다 (문자열 리터럴 내부의 중괄호는 무시).
 */
function sliceObject(str, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * flight 페이로드에서 아이템 레코드를 뽑는다.
 * 페이지마다 한글명 필드가 다르다: 아티팩트는 label_kor, 무기/기적은 value_kor.
 * 레코드는 "value" + (label_kor|value_kor) 를 가진 객체로 식별한다.
 */
function extractRecords(flight) {
  const found = new Map(); // value -> record
  // "value":"..." 를 가진 객체의 시작 '{' 를 찾는다. 키 순서가 페이지마다 달라
  // {"id":... 로 고정할 수 없으므로, value 키를 먼저 찾고 앞쪽의 '{' 로 되짚는다.
  const re = /"value":"[^"]+"/g;
  for (const m of flight.matchAll(re)) {
    // 이 value 키를 감싸는 객체의 시작 위치를 뒤로 훑어 찾는다
    let start = -1;
    let depth = 0;
    for (let i = m.index; i >= 0; i--) {
      const c = flight[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start < 0) continue;

    const raw = sliceObject(flight, start);
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!obj || typeof obj.value !== 'string') continue;

    const kor = obj.label_kor ?? obj.value_kor;
    if (typeof kor !== 'string' || kor.length === 0) continue;
    obj.label_kor = kor;

    // "$undefined" 같은 Next 내부 마커 정리
    for (const k of Object.keys(obj)) {
      if (obj[k] === '$undefined' || obj[k] === null) delete obj[k];
    }
    delete obj.created_at;
    delete obj.uuid;
    found.set(obj.value, obj);
  }
  return [...found.values()];
}

/**
 * flight 에 레코드가 없는 페이지(코스튬 등)를 위한 폴백.
 *
 * 마크업이 이런 모양이다:
 *   <img alt="pink_rabbit" src=".../costume/pink_rabbit.png"/>
 *   <div ...><div class="text-base">분홍 토끼</div>...
 * alt 는 슬러그라 쓸모가 없고, 뒤따르는 첫 한글 텍스트 노드가 이름이다.
 */
function extractFromCards(html) {
  const out = [];
  const re =
    /<img\b[^>]*\bsrc="https:\/\/img\.sephiria\.wiki\/([^/]+)\/([^"?#]+?)\.(?:png|webp|jpe?g)"[^>]*>/g;

  for (const m of html.matchAll(re)) {
    const [tag, category, slug] = m;
    // 이미지 뒤쪽 마크업에서 첫 한글 텍스트 노드를 찾는다
    const tail = html.slice(m.index + tag.length, m.index + tag.length + 600);
    const text = [...tail.matchAll(/>([^<>]+)</g)]
      .map(t => t[1].trim())
      .find(t => /[가-힣]/.test(t));
    if (!text) continue;
    out.push({
      value: slug,
      label_kor: text,
      image: `https://img.sephiria.wiki/${category}/${slug}.png`,
    });
  }
  return out;
}

/** image URL 에서 CDN 카테고리(artifacts/stones/...)를 뽑는다 */
function categoryOf(rec) {
  const m = String(rec.image ?? '').match(/img\.sephiria\.wiki\/([^/]+)\//);
  return m ? m[1] : null;
}

const data = {};
const slugs = {};
const log = [];

for (const page of PAGES) {
  try {
    const html = await fetchPage(page);
    let records = extractRecords(decodeFlight(html));
    let via = 'flight';
    if (records.length === 0) {
      records = extractFromCards(html);
      via = 'cards';
    }
    if (records.length === 0) {
      log.push(`${page}: 레코드 0개 (페이지 구조가 바뀌었을 수 있음)`);
      continue;
    }
    // 페이지명이 아니라 실제 CDN 카테고리로 분류한다 (한 페이지에 여러 종류가 섞여 있을 수 있음)
    for (const rec of records) {
      const cat = categoryOf(rec) ?? page.replace('/', '');
      (data[cat] ??= {})[rec.value] = rec;
      (slugs[cat] ??= {})[rec.value] = rec.label_kor;
    }
    log.push(`${page}: ${records.length}개 (${via})`);
  } catch (err) {
    log.push(`${page}: 실패 (${err.message})`);
  }
}

const counts = Object.fromEntries(
  Object.entries(data).map(([k, v]) => [k, Object.keys(v).length]),
);

await mkdir(OUT_DIR, { recursive: true });

await writeFile(
  join(OUT_DIR, 'wikidata.json'),
  JSON.stringify(
    {
      _source: 'https://www.sephiria.wiki (scripts/fetch-wiki-data.mjs)',
      _generatedAt: new Date().toISOString(),
      _counts: counts,
      _note:
        'effect.sets = 콤보 소속 슬러그. effect.content 의 "a/b/c/d" 는 강화 단계별 수치. ' +
        'label_kor 로 게임 추출 DB(assets/database.json)와 매칭한다.',
      data,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

// 슬러그 → 한글명만 필요한 소비자를 위한 가벼운 버전
await writeFile(
  join(OUT_DIR, 'slugs.json'),
  JSON.stringify({ _generatedAt: new Date().toISOString(), _counts: counts, ...slugs }, null, 2) + '\n',
  'utf8',
);

// ── 아이콘 내려받기 ────────────────────────────────────────
// 오버레이가 오프라인에서도 뜨도록 CDN 이미지를 로컬에 캐시한다.
// 이미 있는 파일은 건너뛴다.

const ICON_DIR = join(OUT_DIR, 'icons');
let downloaded = 0, skipped = 0, failed = 0;

// 아티팩트는 원래 플러그인이 게임에서 직접 뽑아 쓴다 (실제 게임 애셋이라 더 낫다).
// 다만 위키에는 있는데 플레이어의 게임 추출 DB(assets/database.json)엔 없는 항목이
// 있다 — 아직 못 만나본 아이템이거나 최근 추가된 콘텐츠. 그런 항목은 오버레이가
// 실행 중 위키 CDN 을 직접 히트하는데, 그마저 실패하면 깨진 아이콘으로 보인다.
// 그래서 그 차집합만 위키에서 받아 로컬에 캐시해 안전망으로 둔다.
let dbNames = new Set();
try {
  const db = JSON.parse(readFileSync(join(ROOT, 'assets', 'database.json'), 'utf8').replace(/^﻿/, ''));
  dbNames = new Set((db.items || []).map(i => String(i.name || '').replace(/\s/g, '')));
} catch { /* DB 없으면 전부 캐시 대상으로 취급 */ }

for (const [category, records] of Object.entries(data)) {
  const dir = join(ICON_DIR, category);
  await mkdir(dir, { recursive: true });

  for (const rec of Object.values(records)) {
    if (!rec.image) continue;
    // 아티팩트는 플레이어의 게임 DB에 이미 있는 항목이면 그쪽(실제 게임 애셋)을 쓴다
    if (category === 'artifacts' && dbNames.has(String(rec.label_kor || '').replace(/\s/g, ''))) {
      continue;
    }
    const ext = (rec.image.match(/\.(png|webp|jpe?g)(?:$|\?)/i) || [, 'png'])[1];
    const dest = join(dir, `${rec.value}.${ext}`);

    if (existsSync(dest)) { skipped++; continue; }

    try {
      const res = await fetch(rec.image, { headers: { 'User-Agent': UA } });
      if (!res.ok) { failed++; continue; }
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      rec.localIcon = `${category}/${rec.value}.${ext}`;
      downloaded++;
    } catch {
      failed++;
    }
  }

  // 이미 받아둔 파일도 localIcon 을 채워준다
  for (const rec of Object.values(records)) {
    if (rec.localIcon || !rec.image) continue;
    const ext = (rec.image.match(/\.(png|webp|jpe?g)(?:$|\?)/i) || [, 'png'])[1];
    if (existsSync(join(dir, `${rec.value}.${ext}`))) {
      rec.localIcon = `${category}/${rec.value}.${ext}`;
    }
  }
}

log.push(`아이콘: 신규 ${downloaded} · 기존 ${skipped} · 실패 ${failed}`);

// localIcon 이 채워졌으니 다시 저장한다
await writeFile(
  join(OUT_DIR, 'wikidata.json'),
  JSON.stringify(
    {
      _source: 'https://www.sephiria.wiki (scripts/fetch-wiki-data.mjs)',
      _generatedAt: new Date().toISOString(),
      _counts: counts,
      _note:
        'effect.sets = 콤보 소속 슬러그. effect.content 의 "a/b/c/d" 는 강화 단계별 수치. ' +
        'label_kor 로 게임 추출 DB(assets/database.json)와 매칭한다. ' +
        'localIcon 은 assets/wiki/icons/ 아래 상대경로.',
      data,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log(log.join('\n'));
console.log('\n수집 결과:', counts);
console.log('저장:', join(OUT_DIR, 'wikidata.json'));
console.log('저장:', join(OUT_DIR, 'slugs.json'));

if (Object.keys(data).length === 0) process.exit(1);
