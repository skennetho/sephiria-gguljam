// Sephiria 인게임 오버레이 — Electron 메인 프로세스
//
// 투명 + 항상 위 + 클릭 통과 창을 게임 위에 띄운다.
// 게임은 '테두리 없는 창' 모드여야 한다 (독점 전체화면 위에는 어떤 오버레이도 뜨지 못한다).
//
// ⚠ 창을 띄워두는 것 자체에 프레임 비용이 있다.
// 테두리 없는 전체화면에서 윈도우는 게임 화면을 DWM 합성 없이 디스플레이로
// 직접 내보내는 '독립 플립(independent flip)' 경로를 쓴다. 그런데 화면을 덮는
// 항상-위 창이 하나라도 있으면 이 경로가 깨지고 매 프레임 합성을 거치게 되어
// 프레임이 크게 떨어진다. (창모드에서는 원래 합성 경로라 체감 차이가 없다)
//
// 그래서 패널이 하나도 열려 있지 않을 때는 창을 아예 숨긴다. 전역 단축키는
// 창과 무관하게 동작하므로, 사용자가 Ctrl+D 등을 누르는 순간 다시 보여주면 된다.
// 게임 플레이 중(패널 닫힘)에는 오버레이가 프레임에 전혀 영향을 주지 않는다.

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const log = require('./logger').create('main');

process.on('uncaughtException', err => log.exception('uncaught', err));
process.on('unhandledRejection', err => log.exception('unhandledRejection', err));

// 플러그인의 자동 실행과 수동 실행이 겹쳐도 오버레이는 하나만 뜬다
if (!app.requestSingleInstanceLock()) {
  log.info('app', '이미 실행 중인 인스턴스가 있어 종료합니다');
  app.quit();
}

// GPU 셰이더 디스크 캐시 로그 억제
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

let mainWindow = null;

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
    // 숨어 있는 동안에도 인벤토리 구독을 계속 받아야 패널을 열었을 때 최신이다
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
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
  // 시작 시 오버레이를 표시하고 상시 활성 유지 (마우스 통과)
  mainWindow.once('ready-to-show', () => {
    showOverlay();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 전역 단축키 ────────────────────────────────────────

function send(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showOverlay();
    mainWindow.webContents.send(channel);
  }
}

function registerHotkeys() {
  const binds = {
    'CommandOrControl+D': () => send('toggle-optimizer'),
    'CommandOrControl+B': () => send('toggle-builds'),
    'F1': () => send('toggle-team'),
    'CommandOrControl+R': () => send('run-optimize'),
    'CommandOrControl+H': () => send('toggle-hotkey-bar'),
    'CommandOrControl+,': () => send('toggle-settings'),
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

// ── 게임 종료 감지 ─────────────────────────────────────
//
// 예전에는 3초마다 PowerShell 을 띄워 게임 창 위치를 읽었다. 그런데 그
// 스크립트는 Add-Type 으로 C# 을 매번 런타임 컴파일해서 1회 766ms 가 걸렸다
// (분당 15초의 작업). 이게 게임 프레임이 주기적으로 튀는 원인이었다.
//
// 대신 플러그인 WebSocket 연결 상태를 쓴다. 플러그인은 게임 프로세스 안에서
// 돌기 때문에, 연결이 살아 있으면 게임이 켜져 있다는 뜻이다. 비용은 0이다.
//
// 창 위치 추적도 없앴다. 오버레이는 '테두리 없는 창' 모드를 전제로 하므로
// 게임 창 = 디스플레이 전체다. 디스플레이 구성이 바뀌면 그때만 다시 맞춘다.

const GAME_GONE_GRACE_MS = 15000;

let sawGame = false;      // 한 번이라도 플러그인에 연결된 적이 있는가
let goneTimer = null;

/** 렌더러가 WS 연결 상태가 바뀔 때마다 알려준다 */
ipcMain.on('ws-state', (_e, connected) => {
  log.info('game', connected ? '플러그인 연결됨 (게임 실행 중)' : '플러그인 연결 끊김');

  if (connected) {
    sawGame = true;
    if (goneTimer) { clearTimeout(goneTimer); goneTimer = null; }
    return;
  }

  // 연결이 끊겼다. 잠깐의 끊김(플러그인 재시작 등)일 수 있으니 유예를 둔다.
  if (!sawGame || goneTimer) return;
  goneTimer = setTimeout(() => {
    goneTimer = null;
    log.info('game', '플러그인 연결이 끊긴 채 유지됨 — 게임이 종료된 것으로 보고 닫습니다');
    // 스테이징된 업데이트가 있으면 게임 종료 직전에 적용
    applyStagedUpdateOnExit();
    app.quit();
  }, GAME_GONE_GRACE_MS);
});

/** 디스플레이 구성이 바뀌면 창 크기를 다시 맞춘다 */
function trackDisplay() {
  const fit = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { bounds } = screen.getPrimaryDisplay();
    mainWindow.setBounds(bounds);
    log.info('display', '창 크기 재조정', bounds);
  };
  screen.on('display-metrics-changed', fit);
  screen.on('display-added', fit);
  screen.on('display-removed', fit);
}

// ── 창 표시 제어 ───────────────────────────────────────
//
// 패널이 열려 있을 때만 창을 띄운다. 위의 독립 플립 설명 참고.

let panelsOpen = false;

function showOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) {
    // show() 는 게임에서 포커스를 뺏는다. 오버레이는 포커스 없이 떠야 한다.
    mainWindow.showInactive();
  }
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.moveTop();
  log.info('window', '오버레이 표시');
  // 보여줄 때는 항상 통과 상태로 시작한다. 커서가 패널에 들어오면 renderer 가 푼다.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
}

function hideOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 창 자체를 hide() 하면 Windows 가 전역 단축키 전달을 차단하므로,
  // 투명 창을 유지하면서 마우스 통과만 100% 켠다.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  log.info('window', '패널 모두 닫힘 (마우스 통과 유지)');
}

/** 렌더러가 열린 패널 수가 0 <-> 1 로 바뀔 때만 알려준다 */
ipcMain.on('panels-open', (_e, open) => {
  panelsOpen = !!open;
  if (open) showOverlay(); else hideOverlay();
});

// ── 위키 빌드 프록시 ───────────────────────────────────
// 위키가 봇 UA 를 403 처리하고 렌더러에서는 CORS 에 막히므로 메인에서 받아온다.

const WIKI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const buildCache = new Map();   // url -> { at, result }
// '최신정보 검색' 이 목적이므로 캐시는 연타 방지용으로만 짧게 둔다
const CACHE_TTL_MS = 60 * 1000;

const PAGE_SIZE = 10;   // 위키 사이트와 동일

ipcMain.handle('fetch-builds', async (_e, opts = {}) => {
  // 실측한 API 의미: like=asc 가 인기순(좋아요 많은 순), like=desc 가 최신순.
  // 이름과 반대라 헷갈리기 쉬우니 주의.
  // 파라미터 구성은 사이트 번들의 조립 코드와 동일하게 맞췄다:
  //   title=<검색어> + isWriter(true=작성자 검색, false=제목 검색),
  //   costume/weapon/miracle/combo 는 슬러그.
  const params = new URLSearchParams({
    page: String(Math.max(1, opts.page || 1)),
    limit: String(PAGE_SIZE),
    like: opts.sort === 'latest' ? 'desc' : 'asc',
    isLatestVersion: opts.latestOnly ? 'true' : 'false',
    isWriter: String(!!opts.isWriter),
  });
  if (opts.text) params.set('title', opts.text);
  for (const k of ['costume', 'weapon', 'miracle', 'combo']) {
    if (opts[k]) params.set(k, opts[k]);
  }

  const url = `https://www.sephiria.wiki/api/builds?${params}`;

  const hit = buildCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    log.info('wiki', '캐시 사용', { 개수: hit.result.builds.length, page: opts.page });
    return hit.result;
  }
  log.info('wiki', '요청', url);

  const res = await fetch(url, {
    headers: { 'User-Agent': WIKI_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) {
    log.error('wiki', `응답 ${res.status}`, url);
    // 위키가 죽었거나 차단됐다면 마지막 캐시라도 준다
    if (hit) return hit.result;
    throw new Error(`위키 응답 ${res.status}`);
  }

  const json = await res.json();
  const result = {
    builds: json.data || [],
    total: json.count ?? (json.data || []).length,
    pageSize: PAGE_SIZE,
  };
  buildCache.set(url, { at: Date.now(), result });
  log.info('wiki', '응답 수신', { 개수: result.builds.length, 전체: result.total });
  return result;
});

// ── 인앱 업데이트 시스템 ───────────────────────────────
// GitHub Releases API 조회 및 zip 다운로드/적용을 메인 프로세스에서 처리한다.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GITHUB_UA = 'SephiriaTools-Updater/1.0';

/** HTTPS/HTTP GET 요청 (리다이렉트 추적) */
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': GITHUB_UA, ...options.headers },
      timeout: 30000,
    }, res => {
      // 리다이렉트 추적
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, options).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/** GitHub Releases API 에서 최신 릴리스 확인 */
ipcMain.handle('check-update', async (_e, opts) => {
  try {
    const res = await httpGet(opts.apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    const version = (json.tag_name || '').replace(/^v/, '');
    if (!version) return null;

    // zip 다운로드 URL 찾기
    const zipAsset = (json.assets || []).find(a => a.name && a.name.endsWith('.zip'));
    const downloadUrl = zipAsset ? zipAsset.browser_download_url : null;

    return {
      version,
      downloadUrl,
      changelog: json.body || '',
    };
  } catch (err) {
    log.error('update', 'GitHub API 조회 실패', err.message);
    return null;
  }
});

/** 업데이트 다운로드 + 타입에 따라 적용/스테이징 */
ipcMain.handle('download-and-apply-update', async (_e, opts) => {
  const { downloadUrl, type, version, updatesDir } = opts;

  try {
    // 1. 디렉토리 준비
    const downloadDir = path.join(updatesDir, 'download');
    const stagedDir = path.join(updatesDir, 'staged');
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.mkdirSync(stagedDir, { recursive: true });

    const zipPath = path.join(downloadDir, `update-${version}.zip`);

    // 2. zip 다운로드
    log.info('update', '다운로드 시작', downloadUrl);
    const res = await httpGet(downloadUrl);
    const fileStream = fs.createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      res.pipe(fileStream);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
    log.info('update', '다운로드 완료', zipPath);

    if (type === 'patch') {
      // 3a. 패치: zip 에서 app.asar 추출하여 현재 오버레이에 교체
      const extractDir = path.join(downloadDir, `extracted-${version}`);
      fs.mkdirSync(extractDir, { recursive: true });

      await new Promise((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-Command',
          `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`
        ], { timeout: 60000 }, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // app.asar 경로 찾기 (zip 구조: sephiria-gguljam-vX.X.X/Overlay/resources/app.asar)
      const findAsar = (dir) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const full = path.join(dir, item.name);
          if (item.isFile() && item.name === 'app.asar') return full;
          if (item.isDirectory()) {
            const found = findAsar(full);
            if (found) return found;
          }
        }
        return null;
      };

      const newAsar = findAsar(extractDir);
      if (!newAsar) {
        log.error('update', 'app.asar 를 찾을 수 없음');
        return { ok: false, error: 'app.asar not found in zip' };
      }

      // 현재 실행 중인 오버레이의 app.asar 교체
      const currentAsar = path.join(path.dirname(app.getAppPath()), 'app.asar');
      log.info('update', 'app.asar 교체', { from: newAsar, to: currentAsar });

      // 기존 파일 백업
      const backupAsar = currentAsar + '.bak';
      try { fs.copyFileSync(currentAsar, backupAsar); } catch {}
      fs.copyFileSync(newAsar, currentAsar);

      // 정리
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(zipPath); } catch {}

      log.info('update', '패치 업데이트 적용 완료 — 오버레이 재시작');
      app.relaunch();
      app.exit(0);

      return { ok: true };

    } else {
      // 3b. 마이너/메이저: 스테이징만 해두기
      const extractDir = path.join(stagedDir, `sephiria-update-${version}`);
      fs.mkdirSync(extractDir, { recursive: true });

      await new Promise((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-Command',
          `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`
        ], { timeout: 60000 }, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // pending.json 기록
      const pendingInfo = {
        version,
        stagedDir: extractDir,
        downloadedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stagedDir, 'pending.json'),
        JSON.stringify(pendingInfo, null, 2),
        'utf8'
      );

      // 다운로드 zip 정리
      try { fs.unlinkSync(zipPath); } catch {}

      log.info('update', '마이너/메이저 업데이트 스테이징 완료', pendingInfo);
      return { ok: true };
    }
  } catch (err) {
    log.error('update', '업데이트 처리 실패', err.message);
    return { ok: false, error: err.message };
  }
});

/** 게임 종료 시 스테이징된 업데이트를 적용한다 */
function applyStagedUpdateOnExit() {
  try {
    const stagedDir = path.join(
      process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
      'SephiriaTools', 'updates', 'staged'
    );
    const pendingPath = path.join(stagedDir, 'pending.json');
    if (!fs.existsSync(pendingPath)) return;

    const info = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    if (!info || !info.stagedDir || !fs.existsSync(info.stagedDir)) return;

    // install.ps1 찾기 (스테이징된 디렉토리 내부)
    const findScript = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isFile() && item.name === 'install.ps1') return full;
        if (item.isDirectory()) {
          const found = findScript(full);
          if (found) return found;
        }
      }
      return null;
    };

    const installScript = findScript(info.stagedDir);
    if (!installScript) {
      log.warn('update', 'install.ps1 을 찾을 수 없어 스테이징 업데이트를 건너뜁니다');
      return;
    }

    // 게임 디렉토리 찾기 (assets-locator 활용)
    let gameDir;
    try {
      const locator = require('./assets-locator');
      gameDir = locator.findGameDir ? locator.findGameDir() : null;
    } catch {}

    if (!gameDir) {
      log.warn('update', '게임 디렉토리를 찾을 수 없어 스테이징 업데이트를 건너뜁니다');
      return;
    }

    log.info('update', '스테이징된 업데이트 적용 시작', {
      version: info.version,
      script: installScript,
      gameDir,
    });

    // install.ps1 을 비동기로 실행 (오버레이 종료 후에도 실행 계속)
    const ps = execFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', installScript,
      '-GameDir', gameDir,
    ], { detached: true, stdio: 'ignore' });
    ps.unref();

    // pending.json 제거
    try { fs.unlinkSync(pendingPath); } catch {}

    log.info('update', '스테이징 업데이트 install.ps1 실행 완료');
  } catch (err) {
    log.error('update', '스테이징 업데이트 적용 실패', err.message);
  }
}

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
