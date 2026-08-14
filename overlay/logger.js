// 오버레이 공용 로거.
//
// 메인/렌더러 양쪽에서 같은 파일에 쓴다. Electron 렌더러의 console 출력은
// DevTools 에만 보이고 터미널로는 안 나오기 때문에, 파일로 남겨야 나중에 원인을 찾을 수 있다.
//
// 사용:  const log = require('./logger').create('renderer');
//        log.info('ws', '연결됨', { url });
//        log.error('refresh', '인벤토리 없음');
//
// 로그 파일: overlay/overlay.log  (실행 시 기존 파일은 .1 로 밀어둔다)

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'overlay.log');
const MAX_BYTES = 2 * 1024 * 1024;

let stream = null;

function ensureStream() {
  if (stream) return stream;

  try {
    // 너무 커지면 한 세대만 보관하고 새로 시작
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) {
      try { fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch { /* 무시 */ }
    }
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  } catch (err) {
    // 파일에 못 쓰면 콘솔만이라도
    console.error('로그 파일을 열 수 없습니다:', err.message);
  }
  return stream;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmt(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function write(source, level, scope, msg, extra) {
  const line = `[${stamp()}] ${level.padEnd(5)} ${source}/${scope} ${msg}` +
               (extra !== undefined ? ` ${fmt(extra)}` : '');

  const s = ensureStream();
  if (s) { try { s.write(line + '\n'); } catch { /* 무시 */ } }

  // 콘솔에도 남긴다 (메인 프로세스는 터미널에서 바로 보인다)
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

function create(source) {
  return {
    info:  (scope, msg, extra) => write(source, 'INFO', scope, msg, extra),
    warn:  (scope, msg, extra) => write(source, 'WARN', scope, msg, extra),
    error: (scope, msg, extra) => write(source, 'ERROR', scope, msg, extra),

    /** 예외를 스택까지 남긴다 */
    exception: (scope, err) => write(source, 'ERROR', scope,
      (err && err.message) || String(err),
      (err && err.stack) ? err.stack.split('\n').slice(1, 4).join(' | ') : undefined),

    path: LOG_PATH,
  };
}

module.exports = { create, LOG_PATH };
