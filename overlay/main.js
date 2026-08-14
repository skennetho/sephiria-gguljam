// Sephiria 인게임 오버레이 — Electron 메인 프로세스
//
// 투명 + 항상 위 + 클릭 통과 창을 게임 위에 띄운다.
// 게임은 '테두리 없는 창' 모드여야 한다 (독점 전체화면 위에는 어떤 오버레이도 뜨지 못한다).

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { exec } = require('child_process');
const log = require('./logger').create('main');

process.on('uncaughtException', err => log.exception('uncaught', err));
process.on('unhandledRejection', err => log.exception('unhandledRejection', err));

// GPU 셰이더 디스크 캐시 로그 억제
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

let mainWindow = null;
let gamePollTimer = null;
let hasSeenGame = false;

// ── 창 생성 ────────────────────────────────────────────

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    // focusable:false 로 두면 빌드 검색창에 타이핑이 안 된다.
    // 어차피 패널 밖은 클릭이 통과하므로, 포커스는 사용자가 패널을 클릭했을 때만 넘어온다.
    focusable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // 'screen-saver' 레벨이라야 전체화면 게임 위에 올라간다
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 기본은 전부 통과. 패널 위에 올라갔을 때만 renderer 가 꺼준다.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('render-process-gone', (_e, d) =>
    log.error('renderer', '렌더러 종료', d && d.reason));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
    log.error('renderer', `페이지 로드 실패 ${code}`, desc));

  log.info('window', '오버레이 창 생성', { w: bounds.width, h: bounds.height });

  registerHotkeys();
  startGameTracking();

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (gamePollTimer) clearInterval(gamePollTimer);
  });
}

// ── 전역 단축키 ────────────────────────────────────────

function send(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

function registerHotkeys() {
  const binds = {
    'CommandOrControl+D': () => send('toggle-optimizer'),
    'CommandOrControl+B': () => send('toggle-builds'),
    'F1': () => send('toggle-team'),
    'CommandOrControl+R': () => send('run-optimize'),
    'CommandOrControl+H': () => send('toggle-hotkey-bar'),
    'CommandOrControl+Q': () => app.quit(),
    // Esc 는 등록하지 않는다. 전역 단축키로 잡으면 게임의 Esc 가 먹히지 않는다.
    // 패널은 각자의 토글 단축키로 닫는다.
    // 개발용: 오버레이 UI 새로고침 (게임은 건드리지 않는다)
    'F5': () => mainWindow && mainWindow.webContents.reload(),
  };

  const failed = [];
  for (const [accel, fn] of Object.entries(binds)) {
    const ok = globalShortcut.register(accel, () => {
      log.info('hotkey', accel);
      try { fn(); } catch (err) { log.exception('hotkey:' + accel, err); }
    });
    if (!ok) failed.push(accel);
  }
  if (failed.length) log.warn('hotkey', '등록 실패 (다른 앱이 선점)', failed.join(', '));
  else log.info('hotkey', '전체 등록 완료', Object.keys(binds).join(', '));
}

// ── 게임 창 추적 ───────────────────────────────────────
// 게임 창 위치/크기에 오버레이를 맞추고, 게임이 종료되면 같이 종료한다.
// PowerShell 을 매번 새로 띄우면 비싸므로 간격을 넉넉히 둔다.

const PS_GET_RECT = `
$p = Get-Process -Name "Sephiria" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne 0) {
  $sig = '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }'
  $t = Add-Type -MemberDefinition $sig -Name W -Namespace Win32 -PassThru
  $r = New-Object Win32.W+RECT
  [void]$t::GetWindowRect($p.MainWindowHandle, [ref]$r)
  "RECT:$($r.Left),$($r.Top),$($r.Right - $r.Left),$($r.Bottom - $r.Top)"
} else { "NOT_RUNNING" }
`.replace(/\r?\n/g, ' ');

let lastRect = '';

function startGameTracking() {
  if (gamePollTimer) clearInterval(gamePollTimer);

  const poll = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    exec(`powershell -NoProfile -NonInteractive -Command "${PS_GET_RECT}"`, (err, stdout) => {
      if (err || !stdout) return;
      const out = stdout.trim();

      if (out.startsWith('RECT:')) {
        hasSeenGame = true;
        if (out === lastRect) return;   // 변화 없으면 아무것도 하지 않는다
        lastRect = out;

        const [x, y, w, h] = out.slice(5).split(',').map(Number);
        if ([x, y, w, h].some(Number.isNaN) || w <= 0 || h <= 0) return;

        log.info('game', '게임 창 위치 갱신', { x, y, w, h });
        mainWindow.setBounds({ x, y, width: w, height: h });
        mainWindow.webContents.send('game-bounds', { x, y, width: w, height: h });
      } else if (out === 'NOT_RUNNING' && hasSeenGame) {
        log.info('game', 'Sephiria 종료 감지 — 오버레이도 닫습니다');
        app.quit();
      }
    });
  };

  poll();
  gamePollTimer = setInterval(poll, 3000);
}

// ── 위키 빌드 프록시 ───────────────────────────────────
// 위키가 봇 UA 를 403 처리하고 렌더러에서는 CORS 에 막히므로 메인에서 받아온다.

const WIKI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const buildCache = new Map();   // key -> { at, data }
const CACHE_TTL_MS = 5 * 60 * 1000;

ipcMain.handle('fetch-builds', async (_e, opts = {}) => {
  const params = new URLSearchParams({
    page: '1',
    limit: '30',
    like: opts.sort === 'latest' ? 'asc' : 'desc',
    isLatestVersion: opts.latestOnly ? 'true' : 'false',
  });
  if (opts.weapon) params.set('weapon', opts.weapon);

  const url = `https://www.sephiria.wiki/api/builds?${params}`;

  const hit = buildCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    log.info('wiki', '캐시 사용', { 개수: hit.data.length });
    return hit.data;
  }
  log.info('wiki', '요청', url);

  const res = await fetch(url, {
    headers: { 'User-Agent': WIKI_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) {
    log.error('wiki', `응답 ${res.status}`, url);
    // 위키가 죽었거나 차단됐다면 마지막 캐시라도 준다
    if (hit) return hit.data;
    throw new Error(`위키 응답 ${res.status}`);
  }

  const json = await res.json();
  const data = json.data || [];
  buildCache.set(url, { at: Date.now(), data });
  log.info('wiki', '응답 수신', { 개수: data.length });
  return data;
});

// ── 마우스 통과 토글 ───────────────────────────────────

ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setIgnoreMouseEvents(ignore, options);
});

// ── 앱 수명주기 ────────────────────────────────────────

app.whenReady().then(() => {
  log.info('app', '시작', { 로그파일: log.path });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
