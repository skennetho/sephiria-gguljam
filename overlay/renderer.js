// Sephiria 오버레이 렌더러 — 부트스트랩.
//
// 데이터 원천:
//  1. 플러그인 WebSocket (ws://localhost:5827) — 실시간 인벤토리/맵    -> src/ws.js
//  2. 로컬 assets/ — 플러그인이 덤프한 아이콘·아이템 DB                -> src/gamedata.js
//  3. 위키 API — 빌드 목록 (main 프로세스가 대신 받아온다)             -> src/builds-panel.js
//
// 각 패널은 src/ 아래 모듈이 소유한다. 이 파일은 초기화 순서만 정한다.

'use strict';

const { log } = require('./src/util');

// 렌더러에서 터진 예외는 화면에 아무 흔적도 남기지 않는다. 전부 로그로 밀어넣는다.
window.addEventListener('error', e => {
  log.error('window', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`,
            e.error && e.error.stack ? e.error.stack.split('\n').slice(1, 4).join(' | ') : undefined);
});
window.addEventListener('unhandledrejection', e => {
  log.error('promise', String((e.reason && e.reason.message) || e.reason));
});

const gamedata = require('./src/gamedata');
const ws = require('./src/ws');
const shell = require('./src/shell');
const tooltip = require('./src/tooltip');
const optimizerPanel = require('./src/optimizer-panel');
const buildsPanel = require('./src/builds-panel');
const teamPanel = require('./src/team-panel');

(function init() {
  log.info('init', '오버레이 시작');

  gamedata.loadItemDb();
  tooltip.setupArtifactTooltips();

  // 패널이 ws.on() 구독을 먼저 걸어야 connect 직후 오는 메시지를 놓치지 않는다
  optimizerPanel.init();
  buildsPanel.init();
  teamPanel.init();
  shell.init({ runOptimize: optimizerPanel.requestOptimize });

  ws.connect();

  log.info('init', '초기화 완료', { 로그파일: log.path });
})();
