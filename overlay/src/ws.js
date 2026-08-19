// 플러그인 WebSocket 연결 관리.
//
// 패널들은 on(type, handler) 로 메시지를 구독한다. 한 타입에 여러 구독자가
// 붙을 수 있고(예: inventory_update 를 최적배치·빌드 패널이 각각 구독),
// 구독자 하나가 던진 예외는 로그로만 남고 다른 구독자에게 전파되지 않는다.

'use strict';

const { ipcRenderer } = require('electron');
const { log } = require('./util');

const WS_URL = 'ws://127.0.0.1:5827';

let ws = null;
let reconnectTimer = null;
const handlers = new Map();   // type -> [fn, ...]

/**
 * 전체 파싱 없이 앞부분에서 "type" 값만 꺼낸다.
 * 플러그인은 항상 type 을 첫 필드로 직렬화한다. 못 찾으면 null 을 돌려
 * 호출부가 정상 파싱 경로를 타게 한다.
 */
function peekType(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^\{"type":"([a-z_]+)"/.exec(raw);
  return m ? m[1] : null;
}

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
    // 플러그인은 맵 정보도 0.3초마다 보내지만 지금은 구독자가 없다.
    // 타입만 먼저 훑어보고, 아무도 안 듣는 메시지는 파싱조차 하지 않는다.
    const type = peekType(ev.data);
    if (type && !handlers.has(type)) return;

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
  // main 프로세스가 이 신호로 게임 종료를 판단한다 (프로세스 폴링 대체)
  ipcRenderer.send('ws-state', connected);

  const el = document.getElementById('ws-status');
  el.classList.toggle('connected', connected);
  el.classList.toggle('disconnected', !connected);
  document.getElementById('ws-status-text').textContent =
    connected ? '게임 연결됨' : '게임 연결 끊김 — 재시도 중';
}

module.exports = { connect, send, on, isConnected };
