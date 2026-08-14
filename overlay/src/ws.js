// 플러그인 WebSocket 연결 관리.
//
// 패널들은 on(type, handler) 로 메시지를 구독한다. 한 타입에 여러 구독자가
// 붙을 수 있고(예: inventory_update 를 최적배치·빌드 패널이 각각 구독),
// 구독자 하나가 던진 예외는 로그로만 남고 다른 구독자에게 전파되지 않는다.

'use strict';

const { log } = require('./util');

const WS_URL = 'ws://localhost:5827';

let ws = null;
let reconnectTimer = null;
const handlers = new Map();   // type -> [fn, ...]

/** 메시지 타입 구독 */
function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
}

/** WebSocket 전송. 끊겨 있으면 false 를 돌려주고 로그를 남긴다. */
function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log.warn('ws', '전송 실패 — 연결 안 됨', obj && obj.type);
    return false;
  }
  try {
    ws.send(JSON.stringify(obj));
    log.info('ws', '전송', obj && obj.type);
    return true;
  } catch (err) {
    log.exception('ws:send', err);
    return false;
  }
}

function isConnected() {
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log.info('ws', '연결됨', WS_URL);
    setStatus(true);
    send({ type: 'refresh' });
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { log.error('ws', '수신 JSON 파싱 실패', String(ev.data).slice(0, 120)); return; }

    const list = handlers.get(msg.type);
    if (!list) return;
    for (const fn of list) {
      try { fn(msg.data, msg); }
      catch (err) { log.exception(`ws:handle:${msg.type}`, err); }
    }
  };

  ws.onerror = () => { log.warn('ws', '소켓 오류'); setStatus(false); };
  ws.onclose = () => { log.warn('ws', '연결 끊김 — 재접속 예약'); setStatus(false); scheduleReconnect(); };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

function setStatus(connected) {
  const el = document.getElementById('ws-status');
  el.classList.toggle('connected', connected);
  el.classList.toggle('disconnected', !connected);
  document.getElementById('ws-status-text').textContent =
    connected ? '게임 연결됨' : '게임 연결 끊김 — 재시도 중';
}

module.exports = { connect, send, on, isConnected };
