// 공용 유틸리티. DOM/상태에 의존하지 않는 순수 함수만 둔다.

'use strict';

const log = require('../logger').create('renderer');

/** 핸들러에서 예외가 나도 오버레이 전체가 멈추지 않도록 감싼다. */
function guard(scope, fn) {
  return function (...args) {
    try { return fn.apply(this, args); }
    catch (err) { log.exception(scope, err); }
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 위키 본문은 HTML 이다. 태그를 화이트리스트로 제한해 넣는다. */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const allowed = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'SPAN', 'DIV']);
  (function walk(node) {
    for (const child of [...node.children]) {
      walk(child);
      if (!allowed.has(child.tagName)) child.replaceWith(...child.childNodes);
      else [...child.attributes].forEach(a => child.removeAttribute(a.name));
    }
  })(doc.body);
  return doc.body.innerHTML;
}

function formatAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '방금';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
}

module.exports = { log, guard, esc, sanitize, formatAgo };
