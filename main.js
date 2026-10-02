const { app, BrowserWindow, ipcMain, dialog, shell, screen, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// One data folder, run from source or installed. Installed, the app is named "mwcode", which would
// otherwise give it a new, empty folder and lose the saved window, drafts and What's new state.
app.setPath('userData', path.join(app.getPath('appData'), 'mwcode-desktop'));

// One copy at a time: opening mwcode again (a second click, or a login start on top of a restored
// one) brings the open window forward instead of starting another app on the same data.
if (!app.requestSingleInstanceLock()) process.exit(0);
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

// macOS: an app opened from the Dock or Finder gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), not your
// terminal's, so the agent would not find Homebrew's, nvm's or anything else's tools. Your login shell is
// asked for it once, in the background, and what it adds is put in front.
if (process.platform === 'darwin') {
  require('child_process').execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\n__MWPATH__%s__MWPATH__" "$PATH"'],
    { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (_err, out) => {
      const m = /__MWPATH__(.*)__MWPATH__/.exec(String(out || ''));
      if (!m) return;
      const seen = new Set();
      process.env.PATH = [...m[1].split(':'), ...(process.env.PATH || '').split(':')]
        .filter((p) => p && !seen.has(p) && seen.add(p)).join(':');
    });
}
// macOS: quitting (Cmd+Q, the menu, the Dock) closes the window for real; the red button only hides it.
let quitting = false;
app.on('before-quit', () => { quitting = true; });

// Which project was open, and what else has been opened before — so closing
// and reopening the app lands back where you left off instead of resetting to
// wherever the app happens to be installed, and switching projects again is a
// click in a list instead of the OS folder dialog every time.
const STATE_FILE = path.join(app.getPath('userData'), 'desktop-state.json');
const { createRecorder } = require('./recordings');
// Everything the window remembers goes through one durable store written at once (see ui-store.js).
const { createUiStore, writeJsonAtomic, readJson: readStateFile } = require('./ui-store');
let uiStore = null;
// The signed news and update feed (see news/): fetched here, checked here, and only clean items
// ever reach the window.
const { createFeedService } = require('./news/feedService');
const { PUBLIC_KEY: NEWS_PUBLIC_KEY } = require('./news/feedKey');
let newsFeed = null;
// The app's own updates: a signed manifest, a checked download, installed on restart (see updater/).
const { createUpdateService } = require('./updater/updateService');
const { PUBLIC_KEY: UPDATE_PUBLIC_KEY } = require('./updater/updateKey');
let updater = null;
// What the agent saw while testing an app, kept for replay (see recordings.js).
const recorder = createRecorder(path.join(app.getPath('userData'), 'recordings'));
const MAX_RECENT_PROJECTS = 100;

// Windows 11's SMALL rounded corners on the window: the same few pixels the boxes inside
// have. Electron can only turn the rounding on (large) or off, so this asks Windows
// directly (DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUNDSMALL).
// Older Windows has no such setting and simply keeps square corners.
const ROUND_IN_PAGE = process.platform === 'linux';
function roundWindowCorners(win) {
  if (process.platform !== 'win32') return;
  try {
    const koffi = require('koffi');
    const setAttribute = koffi
      .load('dwmapi.dll')
      .func('long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, _In_ uint32_t *value, uint32_t size)');
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const DWMWCP_ROUNDSMALL = 3;
    setAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, [DWMWCP_ROUNDSMALL], 4);
  } catch {
    // Square corners it is: nothing else depends on this.
  }
}

// ── Opening a file in the user's editor ──────────────────────────────────
// VS Code or Cursor when installed, at the line (`-g file:line`). Otherwise whatever Windows
// opens that kind of file with, or its "Open with" choice when nothing is set. Not the Windows
// default first: `.ts` is also a video format, and on a real machine it opened in a player.
// The editor is started the way its own `code.cmd` starts it (its Code.exe running its cli.js),
// so no command window flashes and no path goes through a shell.
let editorLauncher; // undefined = not looked for yet, null = none found
function findEditorLauncher() {
  if (editorLauncher !== undefined) return editorLauncher;
  editorLauncher = null;
  if (process.platform !== 'win32') {
    const names = ['code', 'cursor', 'codium', 'code-insiders'];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const name of names) {
      for (const d of dirs) {
        const exe = path.join(d, name);
        try { fs.accessSync(exe, fs.constants.X_OK); editorLauncher = { exe, cli: null }; return editorLauncher; } catch { /* next */ }
      }
    }
    // macOS: the editors' own command inside the app, for when "code" was never added to the PATH.
    if (process.platform === 'darwin') {
      const apps = ['/Applications', path.join(os.homedir(), 'Applications')];
      const inside = [['Visual Studio Code.app', 'code'], ['Cursor.app', 'cursor'], ['VSCodium.app', 'codium']];
      for (const dir of apps) {
        for (const [bundle, cmd] of inside) {
          const exe = path.join(dir, bundle, 'Contents', 'Resources', 'app', 'bin', cmd);
          try { fs.accessSync(exe, fs.constants.X_OK); editorLauncher = { exe, cli: null }; return editorLauncher; } catch { /* next */ }
        }
      }
    }
    return editorLauncher;
  }
  const local = process.env.LOCALAPPDATA || '';
  const programs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [
    ...(process.env.PATH || '').split(path.delimiter).flatMap((d) => [path.join(d, 'code.cmd'), path.join(d, 'cursor.cmd')]),
    path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    ...programs.map((p) => path.join(p, 'Microsoft VS Code', 'bin', 'code.cmd')),
    path.join(local, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
  ];
  for (const cmd of candidates) {
    try {
      if (!fs.existsSync(cmd)) continue;
      // "%~dp0..\Code.exe" "%~dp0..\<version>\resources\app\out\cli.js" %*
      const m = /"%~dp0([^"]+\.exe)"\s+"%~dp0([^"]+cli\.js)"/i.exec(fs.readFileSync(cmd, 'utf8'));
      if (!m) continue;
      const dir = path.dirname(cmd);
      const exe = path.resolve(dir, m[1]);
      const cli = path.resolve(dir, m[2]);
      if (fs.existsSync(exe) && fs.existsSync(cli)) { editorLauncher = { exe, cli }; break; }
    } catch { /* try the next one */ }
  }
  return editorLauncher;
}

function loadDesktopState() {
  return readStateFile(STATE_FILE) || readStateFile(`${STATE_FILE}.bak`) || { lastProjectCwd: null, recentProjects: [] };
}

// Written whole and at once, never half: a crash cannot leave a damaged file (see ui-store.js).
function saveDesktopState(state) {
  try {
    writeJsonAtomic(STATE_FILE, state, true);
  } catch {
    // Best-effort — a project just won't be remembered next launch, not worth surfacing.
  }
}

// Where the window was, so it opens there. Only a place that is still on a screen is used.
function windowPlacement(saved) {
  const base = { width: 1360, height: 880 };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return base;
  const width = Math.max(900, Math.round(saved.width));
  const height = Math.max(600, Math.round(saved.height));
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { width, height };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const w = Math.min(saved.x + width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + height, a.y + a.height) - Math.max(saved.y, a.y);
    return w >= 200 && h >= 120;
  });
  return visible ? { x: Math.round(saved.x), y: Math.round(saved.y), width, height } : { width, height };
}

// The session you were in, per project: after a restart (an update, a crash, a quit) the app
// opens that one, not merely the newest.
function rememberSession(cwd, id) {
  const state = loadDesktopState();
  state.lastSessionByCwd = { ...(state.lastSessionByCwd || {}), [cwd]: id };
  saveDesktopState(state);
}

// The name a project goes by in the app: the one given in the app (right-click, Rename), else its
// folder's name. Only a label: the folder, its sessions and what the agent sees keep the real name.
function projectName(cwd) {
  const given = loadDesktopState().projectNames?.[cwd];
  return given || path.basename(cwd);
}

// Someone who used the CLI before installing the app already has projects: each session the core saved
// records its folder (`cwd` in <id>.meta.json under ~/.mindweave/projects). On the app's first launch those
// folders become its project list, newest first, so it opens where the CLI left off. Once only: after that
// the list is the app's own, and a project removed from it stays removed. Keys, sessions, rules, MCP
// servers and the rest need nothing: the app reads the same ~/.mindweave as the CLI.
function importCliProjects() {
  const state = loadDesktopState();
  if (state.cliProjectsImported) return;
  const found = new Map(); // cwd -> newest session time
  const root = path.join(process.env.MINDWEAVE_STATE_DIR?.trim() || path.join(os.homedir(), '.mindweave'), 'projects');
  const tmp = path.resolve(os.tmpdir());
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* no CLI state */ }
  for (const d of dirs) {
    let metas = [];
    try { metas = fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.meta.json')); } catch { continue; }
    for (const f of metas) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, d.name, f), 'utf8'));
        const cwd = typeof meta.cwd === 'string' ? meta.cwd : null;
        if (!cwd) continue;
        const when = (v) => (typeof v === 'number' ? v : Date.parse(v || '') || 0); // milliseconds, or an old date string
        const at = when(meta.updatedAt) || when(meta.createdAt);
        if (at > (found.get(cwd) ?? -1)) found.set(cwd, at);
      } catch { /* a damaged file: skip it */ }
    }
  }
  const cli = [...found.entries()]
    .filter(([cwd]) => !path.resolve(cwd).startsWith(tmp) && fs.existsSync(cwd)) // not test runs, still there
    .sort((a, b) => b[1] - a[1])
    .map(([cwd]) => cwd);
  const own = state.recentProjects || [];
  state.recentProjects = [...own, ...cli.filter((p) => !own.includes(p))].slice(0, MAX_RECENT_PROJECTS);
  if (!state.lastProjectCwd && cli.length) state.lastProjectCwd = cli[0];
  state.cliProjectsImported = true;
  saveDesktopState(state);
}

function rememberProject(cwd) {
  const state = loadDesktopState();
  state.lastProjectCwd = cwd;
  state.recentProjects = [cwd, ...(state.recentProjects || []).filter((p) => p !== cwd)].slice(0, MAX_RECENT_PROJECTS);
  saveDesktopState(state);
  return state.recentProjects;
}

// The real Mindweave engine. `mindweave` is pure ESM, so
// it is reached with a dynamic import from this CommonJS main process; loaded once
// and reused for every send.
let turnRunnerPromise = null;
function turnRunner() {
  if (!turnRunnerPromise) {
    turnRunnerPromise = import('mindweave/core').then((core) => {
      core.loadConfig(); // ~/.mindweave/.env, same key layering the CLI uses
      return core;
    });
  }
  return turnRunnerPromise;
}

// ── Run button: what "run this project" means, read from the project itself ──
// Checked in order of how specific the signal is: a desktop-app shell (Tauri,
// Electron) beats a generic dev script. Returns null when nothing is obvious,
// which greys the button out rather than guessing.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function packageManager(cwd) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}
// Where the runnable app is. The project root first, then deeper folders level
// by level (up to MAX_RUN_DEPTH down), so an app kept in ./apps/desktop/app is
// still found. The SHALLOWEST hit wins, since it's the one that's most likely
// "the project"; a tie at the same depth goes to the stronger signal (a desktop
// app over a dev server over a bare script), then to a conventional app folder
// name, then alphabetically, so the same project always picks the same thing.
const MAX_RUN_DEPTH = 5;
const MAX_RUN_DIRS = 600; // a huge tree stops the walk instead of freezing the window
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'venv', 'env',
  '__pycache__', 'bin', 'obj', 'Pods', 'DerivedData', 'tmp', 'temp', 'cache',
]);
const APP_DIR_NAMES = ['app', 'desktop', 'web', 'frontend', 'client', 'ui', 'site', 'www'];

function detectRun(root) {
  let level = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_RUN_DEPTH && level.length; depth++) {
    const hits = [];
    const next = [];
    for (const dir of level) {
      const run = detectRunIn(dir);
      if (run) { hits.push({ dir, run }); continue; } // don't look inside a found project
      if (depth === MAX_RUN_DEPTH) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        if (++visited > MAX_RUN_DIRS) break;
        next.push(path.join(dir, e.name));
      }
    }
    if (hits.length) {
      const nameRank = (d) => {
        const i = APP_DIR_NAMES.indexOf(path.basename(d).toLowerCase());
        return i < 0 ? APP_DIR_NAMES.length : i;
      };
      hits.sort((x, y) => x.run.rank - y.run.rank || nameRank(x.dir) - nameRank(y.dir) || x.dir.localeCompare(y.dir));
      const { dir, run } = hits[0];
      const { rank, ...target } = run;
      if (dir === root) return target;
      return { ...target, dir: path.relative(root, dir).split(path.sep).join('/'), cwd: dir };
    }
    level = next;
  }
  return null;
}

// What runs THIS folder, or null. `rank` orders the signals from strongest.
function detectRunIn(cwd) {
  let names;
  try { names = new Set(fs.readdirSync(cwd)); } catch { return null; }
  const has = (f) => names.has(f);
  const pkg = has('package.json') ? readJson(path.join(cwd, 'package.json')) : null;
  if (pkg) {
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = packageManager(cwd);
    const run = (s) => (s === 'start' && pm === 'npm' ? 'npm start' : `${pm} run ${s}`);
    if (has('src-tauri') && scripts.tauri) return { command: `${pm} run tauri dev`, kind: 'Tauri app', rank: 0 };
    if (deps.electron && scripts.start) return { command: run('start'), kind: 'Electron app', rank: 0 };
    if (deps.electron && scripts.dev) return { command: run('dev'), kind: 'Electron app', rank: 0 };
    if (scripts.dev) return { command: run('dev'), kind: 'dev server', rank: 1 };
    if (scripts.start) return { command: run('start'), kind: 'app', rank: 2 };
    if (scripts.serve) return { command: run('serve'), kind: 'app', rank: 2 };
  }
  const deno = readJson(path.join(cwd, 'deno.json')) ?? readJson(path.join(cwd, 'deno.jsonc'));
  if (deno?.tasks) {
    for (const t of ['dev', 'start']) if (deno.tasks[t]) return { command: `deno task ${t}`, kind: 'Deno app', rank: 1 };
  }
  if (has('pubspec.yaml') && has('lib')) return { command: 'flutter run', kind: 'Flutter app', rank: 0 };
  if (has('Cargo.toml')) return { command: 'cargo run', kind: 'Rust app', rank: 3 };
  if (has('go.mod')) return { command: 'go run .', kind: 'Go app', rank: 3 };
  const csproj = [...names].find((n) => n.endsWith('.csproj'));
  if (csproj) return { command: 'dotnet run', kind: '.NET app', rank: 3 };
  // Linux and macOS name it python3; a plain `python` is often missing there.
  const py = process.platform === 'win32' ? 'python' : 'python3';
  if (has('manage.py')) return { command: `${py} manage.py runserver`, kind: 'Django server', rank: 1 };
  for (const f of ['main.py', 'app.py']) if (has(f)) return { command: `${py} ${f}`, kind: 'Python app', rank: 4 };
  return null;
}

function clipCmd(cmd, max = 44) {
  return cmd.length > max ? `${cmd.slice(0, max - 1)}…` : cmd;
}

function createWindow() {
  const placement = windowPlacement(loadDesktopState().window);
  const win = new BrowserWindow({
    ...placement,
    // The mwcode logo on the window and the taskbar, not Electron's.
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    minWidth: 900,
    minHeight: 600,
    // No title bar: the app draws its own. On Windows the native frame stays (only its title bar is
    // hidden), because Windows animates maximise, minimise and snapping only for framed windows; a
    // frameless one jumps to the new size and its content catches up a beat later.
    // macOS: its own red, yellow and green buttons, top left, centred on the header row (22px down).
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' }
      : process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 } }
        : { frame: false }),
    // Windows 11's default rounding is too round for this app; roundWindowCorners below
    // asks for its small rounding instead. Should that fail, the corners stay square.
    // Windows only: on macOS this option makes the window borderless, which takes away its red, yellow
    // and green buttons and its round corners.
    ...(process.platform === 'win32' ? { roundedCorners: false } : {}),
    resizable: true,
    // Linux: no window manager offers Windows' small round corners, so the window is see-through and the
    // page draws them (styles.css, html.round-window): the same 4px curve, smooth, with Electron's
    // invisible resize border around it left as it is.
    ...(ROUND_IN_PAGE ? { transparent: true, backgroundColor: '#00000000' } : { backgroundColor: windowColour() }),
    // Also Linux's resize border: the system resizes the window from it, as Windows does from its own.
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  roundWindowCorners(win);
  // macOS: the red button hides the window, as Mac apps do (the app stays in the Dock; clicking it brings
  // it back).
  if (process.platform === 'darwin') {
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      if (win.isFullScreen()) { win.once('leave-full-screen', () => win.hide()); win.setFullScreen(false); } else win.hide();
    });
  }
  // Linux: the page rounds its own corners (see-through window, below); it is told when the window is
  // maximised or full screen, where corners are square, as on Windows.
  if (ROUND_IN_PAGE) {
    const square = () => { if (!win.isDestroyed()) win.webContents.send('window:square', win.isMaximized() || win.isFullScreen()); };
    for (const e of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(e, square);
    win.webContents.on('did-finish-load', square);
    // Some Linux setups (WSL among them) resize past the minimum size the window asks for, down to a
    // sliver that can't be grabbed again. Once the resizing has stopped it is put back to the minimum;
    // never during it, where it would fight the drag.
    let settle = null;
    win.on('resize', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
        const [minW, minH] = win.getMinimumSize();
        const [w, h] = win.getSize();
        if (w < minW || h < minH) win.setSize(Math.max(w, minW), Math.max(h, minH));
      }, 400);
    });
  }
  win.loadFile('index.html');

  // The window's size, place and maximised state are kept as they change, so a restart opens it as it was.
  if (loadDesktopState().window?.maximized) win.maximize();
  const saveWindow = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const state = loadDesktopState();
    state.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveDesktopState(state);
  };
  let windowTimer = null;
  const saveWindowSoon = () => { clearTimeout(windowTimer); windowTimer = setTimeout(saveWindow, 400); };
  win.on('resize', saveWindowSoon);
  win.on('move', saveWindowSoon);
  win.on('maximize', saveWindow);
  win.on('unmaximize', saveWindow);
  win.on('close', () => { clearTimeout(windowTimer); saveWindow(); });

  // ── Per-window state ────────────────────────────────────────────────────
  // One project (cwd) and one live session at a time. Switching either disposes
  // the outgoing session's live resources (MCP servers, background shells, LSP)
  // before moving on — same cleanup the CLI does on a session swap.
  importCliProjects();
  const savedState = loadDesktopState();
  // No project yet (a first launch): the session lives in an empty folder of the app's own until one is
  // opened. It is never shown or listed; the window says "Open a project" instead. Never the app's own
  // folder or wherever it was started from, which is what a first launch used to open.
  const NO_PROJECT = path.join(app.getPath('userData'), 'no-project');
  const onDisk = (p) => typeof p === 'string' && p !== NO_PROJECT && fs.existsSync(p);
  const restoredCwd = onDisk(savedState.lastProjectCwd) ? savedState.lastProjectCwd
    : (savedState.recentProjects || []).find(onDisk) || null;
  let currentCwd = restoredCwd;
  if (!currentCwd) {
    fs.mkdirSync(NO_PROJECT, { recursive: true });
    currentCwd = NO_PROJECT;
  } else rememberProject(currentCwd);
  const hasProject = () => currentCwd !== NO_PROJECT;
  // The open project first, then the others: for the pickers in Settings. Never the no-project folder.
  const projectsForPicker = () => [currentCwd, ...(loadDesktopState().recentProjects || []).filter((p) => p !== currentCwd)]
    .filter((p) => p !== NO_PROJECT)
    .map((p) => ({ cwd: p, name: projectName(p), current: p === currentCwd }));
  let activeSession = null;
  let activeSessionId = null;
  let turnRunning = false;
  let bgReacting = false;
  let steerQueue = [];
  let abortController = null;
  const pendingApprovals = new Map();
  // The mode is a CLIENT concept, not saved with the session (see cli/modes.ts —
  // Architect is deliberately never sticky across a fresh launch). It DOES carry
  // from session to session within one running window, same as the CLI: switch
  // to Architect, then open a different session, and it's still Architect.
  let currentModeId = 'lightning';

  ipcMain.on('window:close', () => win.close());
  ipcMain.on('link:open', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
  ipcMain.on('window:minimize', () => win.minimize());
  ipcMain.on('window:maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  // The agent's words for a step wait here until the engine says whether they lead to anything
  // the conversation shows ('narration'). Shown: they go out as text. Not shown (they only led to
  // searches or re-reads): they go out as a note for the working line, not the chat. The reply
  // that ends a turn gets no verdict and goes out with whatever comes next ('done'). A draft the
  // engine threw away ('replyReset') is dropped. The live token count still ticks as they arrive.
  let heldWords = '';

  // A reply that is being written is only in memory until its step ends. So its words are also
  // written to a small file a few times a second (at most a third of a second behind); if the app dies mid-reply, the next start puts
  // them into the conversation, marked as cut off (recoverPartial). Cleared the moment the step
  // is saved (a tool starts, or the turn ends).
  const PARTIAL_FILE = path.join(app.getPath('userData'), 'partial-reply.json');
  let partialBuf = '';
  let partialTimer = null;
  function writePartial() {
    partialTimer = null;
    if (!partialBuf.trim() || !activeSessionId) return;
    // Its own light write (no spare copy): this runs several times a second while a reply streams.
    try {
      const tmp = `${PARTIAL_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ sessionId: activeSessionId, text: partialBuf.slice(-200000) }));
      fs.renameSync(tmp, PARTIAL_FILE);
    } catch { /* best effort */ }
  }
  // Closing the window in the normal way writes whatever has not been written yet.
  win.on('close', () => { if (partialTimer) { clearTimeout(partialTimer); writePartial(); } });
  function clearPartial() {
    partialBuf = '';
    clearTimeout(partialTimer);
    partialTimer = null;
    for (const f of [PARTIAL_FILE, `${PARTIAL_FILE}.bak`, `${PARTIAL_FILE}.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  }
  async function recoverPartial(session) {
    let p = null;
    try { p = JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf8')); } catch { return; }
    if (!p || p.sessionId !== session.id) return;
    clearPartial();
    try {
      const { appendInterruptedReply } = await turnRunner();
      await appendInterruptedReply(session, String(p.text || ''));
    } catch { /* the conversation opens without it */ }
  }

  function sendEvent(e) {
    if (e.type === 'text') {
      heldWords += e.delta;
      partialBuf += e.delta;
      if (!partialTimer) partialTimer = setTimeout(writePartial, 300);
      emitEvent({ type: 'textHeld', n: e.delta.length });
      return;
    }
    if (e.type === 'replyReset') { heldWords = ''; clearPartial(); return; }
    if (e.type === 'toolStart' || e.type === 'done' || e.type === 'error' || e.type === 'userMessage') clearPartial();
    if (e.type === 'narration') {
      const words = heldWords;
      heldWords = '';
      if (!words.trim()) return;
      emitEvent(e.shown ? { type: 'text', delta: words } : { type: 'narrationNote', text: words });
      return;
    }
    if (heldWords && e.type !== 'reasoning' && e.type !== 'usage') {
      const words = heldWords;
      heldWords = '';
      emitEvent({ type: 'text', delta: words });
    }
    emitEvent(e);
  }

  function emitEvent(e) {
    if (!win.isDestroyed()) win.webContents.send('chat:event', e);
    // The context meter follows every call's measured size, a compaction and the
    // end of a turn: the moments the engine's own figure changes.
    if (e.type === 'usage' || e.type === 'compaction' || e.type === 'done') void sendContext();
    // A model call just spent something new, so the cached Spend total is stale —
    // dropped rather than recomputed here, since the page reads it far less often
    // than every call finishes.
    if (e.type === 'usage') {
      spendCache = null;
      // A finished call moved the usage windows: tell an open Limits tab, at most every couple of seconds.
      if (!limitsTick) {
        limitsTick = setTimeout(() => {
          limitsTick = null;
          if (!win.isDestroyed()) win.webContents.send('chat:event', { type: 'limitsChanged' });
        }, 1000);
      }
    }
  }
  let limitsTick = null;

  // How full the context is against the bar auto-compaction fires at.
  async function contextView() {
    if (!activeSession) return null;
    const { contextFill } = await turnRunner();
    return contextFill(activeSession);
  }
  async function sendContext() {
    const view = await contextView();
    if (view && !win.isDestroyed()) win.webContents.send('chat:event', { type: 'context', ...view });
  }
  ipcMain.handle('context:get', contextView);

  // Compact now (the button in the context meter's card). Refused while a turn is
  // running, when the engine is using the transcript. While it runs it holds the
  // turn slot, so anything typed meanwhile is queued exactly as during a turn (shown
  // at once in the queue box), and goes out as the next turn as soon as it ends.
  ipcMain.handle('context:compact', async () => {
    await sendChain; // a send already being prepared goes first
    if (turnRunning) return { ok: false, busy: true };
    const { compactSession } = await turnRunner();
    const session = await ensureSession();
    turnRunning = true;
    let result = { ok: true };
    try {
      await compactSession(session, sendEvent);
    } catch (error) {
      sendEvent({ type: 'error', text: `Compaction failed: ${String(error?.message ?? error)}` });
      sendEvent({ type: 'compactionEnd' });
      result = { ok: false };
    } finally {
      turnRunning = false;
      void sendContext();
    }
    if (!sendQueued()) checkBackgroundWake();
    return result;
  });

  // ── The queue: messages sent while the agent works ──────────────────────
  // Shown in the box above the composer, not in the chat, until they are actually
  // sent: taken in at the next step of the running turn (steer), or sent as the next
  // turn when it ends however it ended (answered, Esc, Send now). A message queued
  // while the agent writes its final answer is never taken in by a step, so the end
  // of the turn is the only place it can go; it used to wait there for good.
  // Same rules as the CLI (cli/messageQueue.ts): a message is 'next' (steered into the
  // running turn at its next step) unless it was typed after Esc, when it is 'now': the
  // turn is stopping, so it is not slipped into it, and goes out on its own afterwards,
  // framed as having stopped it.
  let queueSeq = 0;
  let forceNext = false; // Send now: the whole queue goes out as a message that stopped the turn
  let interrupting = false; // Esc pressed; cleared when the next turn starts
  // Messages typed while the agent works wait here; they are also kept in a file, so a crash cannot
  // eat them. At the next start they come back as the message being typed (restoreQueuedMessages).
  const QUEUE_FILE = path.join(app.getPath('userData'), 'queued-messages.json');
  function persistQueue() {
    const items = steerQueue.map((m) => m.raw).filter(Boolean);
    try {
      if (!items.length) { for (const f of [QUEUE_FILE, `${QUEUE_FILE}.bak`, `${QUEUE_FILE}.tmp`]) fs.rmSync(f, { force: true }); }
      else writeJsonAtomic(QUEUE_FILE, { cwd: currentCwd, items });
    } catch { /* best effort */ }
  }
  function sendQueue() {
    persistQueue();
    sendEvent({
      type: 'queue',
      items: steerQueue.map((m) => ({ id: m.qid, text: m.displayText, files: m.files ?? [], images: (m.imagePaths ?? []).length })),
    });
  }
  // Everything queued as ONE message, the way the CLI sends consecutive queued
  // messages: one turn that reads them together, not one turn per message.
  function batchOf(items) {
    return {
      displayText: items.map((m) => m.displayText).join('\n\n'),
      content: items.map((m) => m.content).join('\n\n'),
      images: items.flatMap((m) => m.images ?? []),
      imagePaths: items.flatMap((m) => m.imagePaths ?? []),
      files: items.flatMap((m) => m.files ?? []),
    };
  }
  /** Nothing is running: send what is queued as the next turn. False when empty.
   *  Send now takes everything; otherwise a 'now' message goes alone, and consecutive
   *  'next' ones go together. What is left goes when that turn ends, and so on. */
  function sendQueued() {
    if (turnRunning || steerQueue.length === 0 || !activeSession) return false;
    const session = activeSession;
    let take;
    let arrival;
    if (forceNext) {
      take = steerQueue.length;
      arrival = 'interrupting';
    } else if (steerQueue[0].priority === 'now') {
      take = 1;
      arrival = 'interrupting';
    } else {
      take = 0;
      while (take < steerQueue.length && steerQueue[take].priority !== 'now') take++;
    }
    const msg = batchOf(steerQueue.slice(0, take));
    steerQueue = steerQueue.slice(take);
    forceNext = false;
    sendQueue();
    turnRunning = true;
    sendEvent({ type: 'userMessage', text: msg.displayText, images: msg.imagePaths, files: msg.files });
    void turnRunner().then(({ runTurn }) =>
      runOneTurn((handlers) => runTurn(session, { content: msg.content, images: msg.images, ...(arrival ? { arrival } : {}) }, handlers)),
    );
    return true;
  }
  // ↑ or Edit: the whole queue back into the composer, as typed, to change or drop.
  ipcMain.handle('queue:pull', () => {
    const items = steerQueue.map((m) => m.raw).filter(Boolean);
    steerQueue = [];
    forceNext = false;
    interrupting = false;
    sendQueue();
    return items;
  });
  // Send now: stop the turn; the queue then goes out at once, framed as having
  // stopped it. Only the turn: background commands keep running (that is Esc's job).
  ipcMain.handle('queue:sendNow', () => {
    if (steerQueue.length === 0) return false;
    forceNext = true;
    abortController?.abort();
    if (pendingApprovals.size) {
      for (const resolve of pendingApprovals.values()) resolve(undefined);
      pendingApprovals.clear();
      sendEvent({ type: 'approvalsDismissed' });
    }
    if (!turnRunning) sendQueued();
    return true;
  });

  function resetTurnState() {
    turnRunning = false;
    bgReacting = false;
    steerQueue = [];
    forceNext = false;
    sendQueue();
    abortController = null;
    for (const resolve of pendingApprovals.values()) resolve(undefined);
    pendingApprovals.clear();
  }

  // Runs one turn (a fresh send or a background-shell reaction) with the same
  // bookkeeping either way: an abort controller a stop button can reach, and a
  // steer queue that drains anything typed while this turn is already running.
  // After a stop, how long a turn gets to wind down before it is let go. A call that does not
  // honour the stop (a tool stuck on an app that was closed) must not hold the app hostage:
  // past this the turn is over as far as the app is concerned, and whatever it still says is
  // dropped.
  const STOP_GRACE_MS = 2000;

  async function runOneTurn(start) {
    turnRunning = true;
    interrupting = false; // a new turn: what is typed now is for it
    const controller = new AbortController();
    abortController = controller;
    let letGo = false;
    let ended = false;
    let graceTimer = null;
    const letGoAfterStop = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => { graceTimer = setTimeout(resolve, STOP_GRACE_MS); }, { once: true });
    }).then(() => {
      if (ended) return;
      letGo = true;
      sendEvent({ type: 'done' });
    });
    try {
      const turn = start({
        signal: controller.signal,
        onEvent: (e) => { if (!letGo) sendEvent(e); },
        steer: async () => {
          // Only the leading 'next' messages: one typed after Esc waits for the end.
          let n = 0;
          while (n < steerQueue.length && steerQueue[n].priority !== 'now') n++;
          if (n === 0) return [];
          const drained = steerQueue.slice(0, n);
          steerQueue = steerQueue.slice(n);
          // Each entry is a prepared message (prepareMessage): the same display
          // text the queued bubble showed, and the files/images it carries.
          for (const m of drained) sendEvent({ type: 'userMessage', text: m.displayText, images: m.imagePaths, files: m.files });
          sendQueue(); // taken in: the box empties as they land in the chat
          return drained.map((m) => ({ content: m.content, ...(m.images.length ? { images: m.images } : {}) }));
        },
      });
      // A turn that was let go may still fail later, with nobody waiting on it.
      turn.catch(() => {});
      await Promise.race([letGoAfterStop, turn]);
    } catch (error) {
      if (!letGo) {
        sendEvent({ type: 'error', text: String(error?.message ?? error) });
        sendEvent({ type: 'done' });
      }
    } finally {
      ended = true;
      clearTimeout(graceTimer);
      turnRunning = false;
      // What is still queued is the next request; otherwise a shell may have finished
      // while this turn was running.
      if (!sendQueued()) checkBackgroundWake();
    }
  }

  // A background command finishing while nothing is running wakes the model to
  // report it, exactly like the CLI's reactToBackground — same wake rule
  // (cli/backgroundWake.ts), just without a picker/dialog state to hold it back
  // here (this app has no modal turn-blocking overlay of that kind yet).
  function checkBackgroundWake() {
    if (!activeSession || bgReacting) return;
    void (async () => {
      const { shouldReactToBackground, continueTurn, providerSummaries } = await turnRunner();
      const mgr = activeSession.toolContext.backgroundShells;
      const wake = shouldReactToBackground({
        ready: true,
        busy: turnRunning,
        // No provider connected: nobody to report to. Waking anyway started a turn that could only fail.
        needsKey: !providerSummaries().some((p) => p.connected),
        reacting: bgReacting,
        modalOpen: false,
        pending: mgr?.pendingCount() ?? 0,
      });
      if (!wake) return;
      bgReacting = true;
      try {
        await runOneTurn((handlers) => continueTurn(activeSession, handlers));
      } finally {
        bgReacting = false;
      }
    })();
  }

  // Fired whenever a background shell changes state. Mirrors the CLI's
  // handleBgChange: a shell coming up or being killed on request is not news,
  // but stalling or dying on its own is worth a line even before any wake turn.
  function handleBgChange() {
    sendShells();
    const mgr = activeSession?.toolContext.backgroundShells;
    for (const { info: sh, kind } of mgr?.takeUiEvents() ?? []) {
      if (kind === 'ready') continue;
      if (kind === 'stalled') {
        const why = sh.stallReason === 'prompt' ? 'waiting for input?' : 'no output for a while — stuck?';
        sendEvent({ type: 'activity', line: `shell #${sh.id} (${clipCmd(sh.command)}) ${why}`, error: true, shell: { id: sh.id, command: sh.command, state: 'stalled', why } });
        continue;
      }
      if (sh.status === 'killed' && sh.stoppedBy === 'user') continue;
      const verb = sh.status === 'killed' ? 'killed' : `finished — exit ${sh.exitCode}`;
      sendEvent({ type: 'activity', line: `shell #${sh.id} (${clipCmd(sh.command)}) ${verb}`, error: sh.status !== 'killed' && sh.exitCode !== 0, shell: { id: sh.id, command: sh.command, state: sh.status === 'killed' ? 'killed' : 'exited', exitCode: sh.exitCode } });
    }
    checkBackgroundWake();
  }

  async function attach(session) {
    const { attachHandlers, applySessionMode, sessionMode, APPROVAL_DISMISSED, PLAN_FEEDBACK } = await turnRunner();
    attachHandlers(session, {
      interrupt: () => abortController?.abort(),
      requestApproval: (question, options, detail, detailTitle, freeText) =>
        new Promise((resolve) => {
          const id = crypto.randomUUID();
          pendingApprovals.set(id, resolve);
          // Which kind of decision, for the dock's badge and layout: a titled one is a
          // permission (Sentinel), exit_plan's own feedback row marks a plan, and any
          // other typed-answer row is a question (ask_user).
          const kind = detailTitle ? 'permission' : freeText?.label === PLAN_FEEDBACK.label ? 'plan' : freeText ? 'question' : 'permission';
          sendEvent({ type: 'approvalRequest', id, question, options, detail, detailTitle, freeText, kind });
        }).then((choice) => (choice === undefined ? APPROVAL_DISMISSED : choice)),
      // The engine itself can move planMode/guarded mid-turn (a plan gets
      // approved via exit_plan, then restored when the turn ends) — reflect
      // that back to the indicator instead of it silently going stale.
      // The app the agent is testing, while it tests: shown live in the chat and kept on
      // disk so the test can be replayed afterwards.
      onLive: (e) => {
        recorder.record(e);
        sendEvent({ type: 'uiLive', ...e });
      },
      onModeChange: async () => {
        currentModeId = sessionMode(session);
        sendEvent({ type: 'modeChanged', mode: await currentMode() });
      },
    });
    // A new/swapped session inherits whatever mode is currently active in this
    // window, same as the CLI (App.tsx's attachApproval does the same).
    applySessionMode(session, currentModeId);
    session.toolContext.backgroundShells?.setOnChange(handleBgChange);
    sendShells(session); // runs before it becomes activeSession, so name it
    // MCP servers connect in the background; tell the Settings page as each one settles.
    const { onMcpChange } = await turnRunner();
    onMcpChange(session, () => { if (!win.isDestroyed()) win.webContents.send('mcp:changed'); });
  }

  async function currentMode() {
    const { modeById } = await turnRunner();
    const m = modeById(currentModeId);
    return { id: m.id, name: m.name, descriptor: m.descriptor };
  }

  // Ensures a session is live for `currentCwd`, picking up the most recently
  // used one so reopening the app finds the conversation already there — no
  // separate "resume" step. Only creates a brand-new session if none exist yet.
  // The project's chosen starting mode (Settings > Permissions), applied once each time
  // a project opens: at launch and on a project switch. Within a project the mode then
  // carries from chat to chat as before, so this never overrides a choice made since.
  let modeDefaultAppliedFor = null;
  // Several things ask for the session while the app starts. They must all get the SAME one: two loads
  // at once made two copies, and whichever finished last was the one the app kept, so a save from it
  // could overwrite what the other had written.
  let ensuring = null;
  function ensureSession() {
    if (activeSession) return Promise.resolve(activeSession);
    if (!ensuring) ensuring = loadActiveSession().finally(() => { ensuring = null; });
    return ensuring;
  }
  async function loadActiveSession() {
    if (activeSession) return activeSession;
    const { startSession, loadSession, listSessions, defaultModeFor } = await turnRunner();
    if (modeDefaultAppliedFor !== currentCwd) {
      modeDefaultAppliedFor = currentCwd;
      const preferred = await defaultModeFor(currentCwd).catch(() => null);
      if (preferred) currentModeId = preferred;
    }
    const metas = await listSessions(currentCwd);
    const savedId = loadDesktopState().lastSessionByCwd?.[currentCwd];
    const wanted = metas.find((m) => m.id === savedId) || metas[0];
    const session = wanted ? await loadSession(currentCwd, wanted.id) : await startSession(currentCwd);
    await recoverPartial(session);
    await attach(session);
    activeSession = session;
    activeSessionId = session.id;
    rememberSession(currentCwd, session.id);
    return session;
  }

  // The title the session notes gave it (what the work is about), else what was said first.
  function sessionLabel(meta) {
    if (meta.title) return meta.title;
    const text = (meta.firstPrompt || '').trim();
    if (!text) return 'New session';
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  }

  // Pins and names you gave sessions yourself: the app's own, kept by session id.
  function sessionPrefs() {
    return loadDesktopState().sessionPrefs || {};
  }
  function setSessionPref(id, patch) {
    const state = loadDesktopState();
    const prefs = state.sessionPrefs || {};
    const next = { ...(prefs[id] || {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false || next[k] === '') delete next[k];
    if (Object.keys(next).length) prefs[id] = next; else delete prefs[id];
    state.sessionPrefs = prefs;
    saveDesktopState(state);
  }

  async function sessionSummaries() {
    const { listSessions } = await turnRunner();
    const metas = await listSessions(currentCwd);
    const prefs = sessionPrefs();
    return metas.map((m) => ({
      id: m.id,
      label: prefs[m.id]?.name || sessionLabel(m),
      pinned: !!prefs[m.id]?.pinned,
      updatedAt: m.updatedAt,
      entryCount: m.entryCount,
      active: m.id === activeSessionId,
    }));
  }

  ipcMain.handle('session:pin', async (_event, id, pinned) => {
    setSessionPref(id, { pinned: !!pinned });
    return sessionSummaries();
  });
  ipcMain.handle('session:rename', async (_event, id, name) => {
    // Empty gives the session back its own title.
    setSessionPref(id, { name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined });
    return sessionSummaries();
  });

  async function currentModel() {
    const { sessionModel } = await turnRunner();
    return sessionModel(activeSession);
  }

  async function currentThinking() {
    const { sessionThinkLevels } = await turnRunner();
    return sessionThinkLevels(activeSession);
  }

  // Shared by the OS folder picker AND clicking a remembered recent project —
  // one path for "the project changed," so the two can never drift apart.
  async function switchProject(newCwd) {
    if (activeSession) {
      const { disposeSession } = await turnRunner();
      await disposeSession(activeSession);
    }
    currentCwd = newCwd;
    activeSession = null;
    activeSessionId = null;
    resetTurnState();
    // The no-project folder is never remembered: it isn't a project.
    const recentProjects = hasProject() ? rememberProject(currentCwd) : (loadDesktopState().recentProjects || []);

    const session = await ensureSession();
    const { replayHistory } = await turnRunner();
    return {
      cwd: hasProject() ? currentCwd : null,
      name: hasProject() ? projectName(currentCwd) : '',
      noProject: !hasProject(),
      recentProjects: recentProjects.map((p) => ({ cwd: p, name: projectName(p) })),
      sessionId: session.id,
      sessions: await sessionSummaries(),
      model: await currentModel(),
      thinking: await currentThinking(),
      mode: await currentMode(),
      replay: replayHistory(session),
    };
  }

  ipcMain.handle('app:init', async () => {
    const session = await ensureSession();
    const { replayHistory } = await turnRunner();
    const recentProjects = loadDesktopState().recentProjects || [];
    return {
      cwd: hasProject() ? currentCwd : null,
      name: hasProject() ? projectName(currentCwd) : '',
      noProject: !hasProject(),
      recentProjects: recentProjects.map((p) => ({ cwd: p, name: projectName(p) })),
      sessionId: session.id,
      sessions: await sessionSummaries(),
      model: await currentModel(),
      thinking: await currentThinking(),
      mode: await currentMode(),
      replay: replayHistory(session),
    };
  });

  // Settings > Analytics. The flag lives in ~/.mindweave/analytics.json, shared
  // with the CLI, so switching it off here switches it off there too.
  ipcMain.handle('analytics:get', async () => {
    const { analyticsEnabled } = await turnRunner();
    return { enabled: analyticsEnabled(), paused: true };
  });
  ipcMain.handle('analytics:set', async (_e, on) => {
    const { analyticsEnabled, setAnalyticsEnabled } = await turnRunner();
    setAnalyticsEnabled(!!on); // refused while the count is paused
    return { enabled: analyticsEnabled(), paused: true };
  });

  // Feedback to the maintainer: the CLI's /feedback. The engine builds the payload
  // (message, version, platform, nothing else), refuses a pasted key, and judges
  // delivery by what the form answered, not by the status code.
  ipcMain.handle('feedback:info', async () => {
    const { appVersion, MAX_MESSAGE, ISSUES_URL } = await turnRunner();
    // The app has its own version. The core engine is the mindweave package, and the CLI the app
    // installs is that same package, so those two read the same number.
    return { version: appVersion(), appVersion: app.getVersion(), coreVersion: appVersion(), cliVersion: appVersion(), platform: process.platform, max: MAX_MESSAGE, issuesUrl: ISSUES_URL };
  });
  ipcMain.handle('feedback:send', async (_e, text) => {
    const { buildFeedback, refuseReason, sendFeedback, appVersion } = await turnRunner();
    const refused = refuseReason(String(text ?? ''));
    if (refused) return { ok: false, message: refused };
    return sendFeedback(buildFeedback(String(text), `${app.getVersion()} (core ${appVersion()})`));
  });

  // General settings. Name, experience level and reply style live in the
  // engine's machine-wide profile, so the CLI follows them too; the send key and
  // launch-at-login belong to this app.
  //
  // Launch at login: a packaged app registers itself. Run from source, the
  // executable is electron.exe, which started alone opens Electron's default
  // app, so the app folder has to be passed as its argument. Reading the state
  // back needs the same path+args, or Windows reports a different entry.
  const loginItem = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
  // Linux has no login-item API: an XDG autostart entry does it, read by every major desktop (GNOME, KDE,
  // XFCE…). It starts the AppImage file when the app is one (its mount path changes every run), else the
  // installed launcher (the mwcode script beside the binary, which picks X11 or Wayland); run from source,
  // Electron with the app folder.
  const AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'mwcode.desktop');
  const quoteExec = (p) => '"' + String(p).replace(/(["`$\\])/g, '\\$1') + '"';
  function linuxLoginExec() {
    if (process.env.APPIMAGE) return quoteExec(process.env.APPIMAGE);
    if (app.isPackaged) return quoteExec(path.join(path.dirname(process.execPath), 'mwcode'));
    return [process.execPath, app.getAppPath()].map(quoteExec).join(' ');
  }
  function openAtLogin() {
    if (process.platform !== 'linux') return app.getLoginItemSettings(loginItem).openAtLogin;
    try { return !/^Hidden=true$/m.test(fs.readFileSync(AUTOSTART, 'utf8')); } catch { return false; }
  }
  function setOpenAtLogin(on) {
    if (process.platform !== 'linux') { app.setLoginItemSettings({ openAtLogin: on, ...loginItem }); return; }
    if (!on) { fs.rmSync(AUTOSTART, { force: true }); return; }
    fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
    fs.writeFileSync(AUTOSTART, ['[Desktop Entry]', 'Type=Application', 'Name=mwcode', 'Comment=Coding agent', `Exec=${linuxLoginExec()}`, 'Icon=mwcode', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
  }
  async function prefsView() {
    const { readProfile } = await turnRunner();
    const p = readProfile();
    return {
      name: p.name, level: p.level, style: p.style,
      sendKey: loadDesktopState().sendKey === 'ctrl' ? 'ctrl' : 'enter',
      theme: savedTheme(),
      openAtLogin: openAtLogin(),
    };
  }
  ipcMain.handle('prefs:get', prefsView);
  ipcMain.handle('prefs:set', async (_e, next = {}) => {
    const profile = {};
    if (typeof next.name === 'string') profile.name = next.name;
    if (typeof next.level === 'string') profile.level = next.level;
    if (typeof next.style === 'string') profile.style = next.style;
    if (Object.keys(profile).length) {
      const { saveProfile } = await turnRunner();
      saveProfile(profile);
    }
    if (next.sendKey === 'ctrl' || next.sendKey === 'enter') {
      const state = loadDesktopState();
      state.sendKey = next.sendKey;
      saveDesktopState(state);
    }
    if (THEMES.includes(next.theme)) {
      const state = loadDesktopState();
      state.theme = next.theme;
      saveDesktopState(state);
      nativeTheme.themeSource = next.theme;
      if (!win.isDestroyed() && !ROUND_IN_PAGE) win.setBackgroundColor(windowColour());
    }
    if (typeof next.openAtLogin === 'boolean') {
      try { setOpenAtLogin(next.openAtLogin); } catch { /* not saved: the switch reads back the truth */ }
    }
    return prefsView();
  });

  // The open project's MINDWEAVE.md (in its root), the notebook the agent keeps.
  ipcMain.handle('notes:get', async () => (await turnRunner()).readProjectNotes(currentCwd));
  ipcMain.handle('notes:save', async (_e, text) => {
    if (typeof text !== 'string') return null;
    const { saveProjectNotes, readProjectNotes } = await turnRunner();
    await saveProjectNotes(currentCwd, text, activeSession);
    return readProjectNotes(currentCwd);
  });
  // Upload only READS the picked file; its text opens in the editor so you see
  // what will replace your notes before anything is saved.
  ipcMain.handle('notes:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a MINDWEAVE.md',
      properties: ['openFile'],
      filters: [{ name: 'Markdown or text', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    try {
      const info = fs.statSync(file);
      if (info.size > 512 * 1024) return { error: 'That file is over 512 KB, too big for notes.' };
      return { name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory'] });
    if (!win.isDestroyed()) { win.focus(); win.webContents.focus(); }
    if (result.canceled || result.filePaths.length === 0) return null;
    return switchProject(result.filePaths[0]);
  });

  // Rename (cosmetic) and remove (from the list only) a project. Neither touches the folder or its sessions.
  const projectList = () => (loadDesktopState().recentProjects || []).map((p) => ({ cwd: p, name: projectName(p) }));
  ipcMain.handle('project:rename', (_event, cwd, name) => {
    const state = loadDesktopState();
    const names = { ...(state.projectNames || {}) };
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    // Empty, or the folder's own name, gives the project back its folder name.
    if (!clean || clean === path.basename(cwd)) delete names[cwd]; else names[cwd] = clean;
    state.projectNames = names;
    saveDesktopState(state);
    return { recentProjects: projectList(), name: hasProject() ? projectName(currentCwd) : '' };
  });
  ipcMain.handle('project:forget', async (_event, cwd) => {
    const open = cwd === currentCwd;
    if (open && turnRunning) return null; // not while the agent is working in it
    const state = loadDesktopState();
    state.recentProjects = (state.recentProjects || []).filter((p) => p !== cwd);
    if (state.projectNames) delete state.projectNames[cwd];
    if (open) state.lastProjectCwd = null;
    saveDesktopState(state);
    if (!open) return { recentProjects: projectList(), name: hasProject() ? projectName(currentCwd) : '' };
    // The open project: the next one in the list opens, or, when it was the last, none (as on a first launch).
    const next = state.recentProjects.find(onDisk);
    if (!next) fs.mkdirSync(NO_PROJECT, { recursive: true });
    return { switched: await switchProject(next || NO_PROJECT) };
  });

  ipcMain.handle('project:switchTo', async (_event, cwd) => {
    if (cwd === currentCwd || !fs.existsSync(cwd)) return null;
    return switchProject(cwd);
  });

  ipcMain.handle('session:new', async () => {
    if (turnRunning) return null; // let the current turn finish first
    if (activeSession) {
      const { disposeSession } = await turnRunner();
      await disposeSession(activeSession);
    }
    const { startSession } = await turnRunner();
    const session = await startSession(currentCwd);
    await attach(session);
    activeSession = session;
    activeSessionId = session.id;
    rememberSession(currentCwd, session.id);
    resetTurnState();
    return { sessionId: session.id, sessions: await sessionSummaries(), model: await currentModel(), thinking: await currentThinking(), mode: await currentMode(), replay: [] };
  });

  // The open session's whole history, for "Show earlier" after a long run trimmed the chat.
  ipcMain.handle('session:replay', async () => {
    if (!activeSession) return [];
    const { replayHistory } = await turnRunner();
    return replayHistory(activeSession);
  });

  ipcMain.handle('session:switch', async (_event, id) => {
    if (turnRunning || id === activeSessionId) return null;
    const { loadSession, disposeSession, replayHistory } = await turnRunner();
    const session = await loadSession(currentCwd, id);
    if (!session) return null;
    if (activeSession) await disposeSession(activeSession);
    await recoverPartial(session);
    await attach(session);
    activeSession = session;
    activeSessionId = session.id;
    rememberSession(currentCwd, session.id);
    resetTurnState();
    return { sessionId: session.id, sessions: await sessionSummaries(), model: await currentModel(), thinking: await currentThinking(), mode: await currentMode(), replay: replayHistory(session) };
  });

  ipcMain.handle('providers:list', async () => {
    const { refreshDiscoveredModels, providerSummaries } = await turnRunner();
    await refreshDiscoveredModels().catch(() => {}); // best-effort — a stale list beats none
    return providerSummaries();
  });

  ipcMain.handle('model:set', async (_event, modelId) => {
    if (turnRunning) return null; // switching mid-stream would race the in-flight driver
    const session = await ensureSession();
    const { setSessionModel } = await turnRunner();
    await setSessionModel(session, modelId);
    // Remembered for the picker's "Recent" section, newest first.
    const state = loadDesktopState();
    state.recentModels = [modelId, ...(state.recentModels || []).filter((m) => m !== modelId)].slice(0, 12);
    saveDesktopState(state);
    return { model: await currentModel(), thinking: await currentThinking() };
  });

  // The composer's model picker: the current provider's models with what each costs
  // and can do (the engine's own tables), plus the ones picked recently.
  ipcMain.handle('models:picker', async (_event, providerId) => {
    const { refreshDiscoveredModels, providerDetail } = await turnRunner();
    await refreshDiscoveredModels().catch(() => {});
    const detail = providerDetail(providerId);
    if (!detail) return null;
    const ids = new Set(detail.models.map((m) => m.id));
    const recent = (loadDesktopState().recentModels || []).filter((m) => ids.has(m)).slice(0, 5);
    return { providerId: detail.id, label: detail.label, models: detail.models, recent };
  });

  ipcMain.handle('thinking:set', async (_event, level) => {
    if (turnRunning) return null;
    const session = await ensureSession();
    const { setSessionThinking } = await turnRunner();
    await setSessionThinking(session, level);
    return currentThinking();
  });

  ipcMain.handle('mode:list', async () => {
    const { MODES } = await turnRunner();
    return MODES.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name, descriptor: m.descriptor }));
  });

  ipcMain.handle('mode:set', async (_event, id) => {
    const session = await ensureSession();
    const { applySessionMode } = await turnRunner();
    currentModeId = id;
    applySessionMode(session, id);
    return currentMode();
  });

  // Key management for one provider. Every action returns the fresh view, so the
  // screen always redraws from what is actually stored. No whole key ever crosses
  // to the renderer: a view carries last-four hints and names only.
  ipcMain.handle('keys:get', async (_e, id) => (await turnRunner()).providerKeys(id));
  ipcMain.handle('keys:act', async (_e, { id, action, slot, value, label, on }) => {
    const tr = await turnRunner();
    const actions = {
      add: () => tr.addProviderKey(id, value ?? '', label ?? ''),
      edit: () => tr.editProviderKey(id, slot, value ?? ''),
      remove: () => tr.removeProviderKey(id, slot),
      use: () => tr.useProviderKey(id, slot),
      makeDefault: () => tr.makeDefaultProviderKey(id, slot),
      rename: () => tr.renameProviderKey(id, slot, label ?? ''),
      disable: () => tr.setProviderKeyDisabled(id, slot, true),
      enable: () => tr.setProviderKeyDisabled(id, slot, false),
      autoSwitch: () => { tr.setProviderAutoSwitch(id, !!on); return { ok: true }; },
    };
    const run = actions[action];
    const result = run ? run() : { ok: false, error: `Unknown action: ${action}` };
    return { result, view: tr.providerKeys(id), providers: tr.providerSummaries() };
  });

  // Permissions: standing lists per project or for all projects, plus this chat's
  // temporary allowances. Every action returns the fresh view to redraw from.
  // `cwd` picks which project's rules to show; the open project when omitted. The
  // project list is the recent projects, with the open one first.
  async function permPayload(tr, session, cwd) {
    const projects = projectsForPicker();
    return { view: await tr.permissionsView(session, cwd || session.cwd), projects };
  }
  ipcMain.handle('perm:get', async (_e, cwd) => {
    const tr = await turnRunner();
    return permPayload(tr, await ensureSession(), cwd);
  });
  // Protected files: pick files or a folder with the system dialog instead of typing
  // a path. Returned relative to the project, which is how the list stores them; a
  // pick outside the project is refused, since a rule there would never match.
  ipcMain.handle('perm:pick', async (_e, { cwd, folder }) => {
    const root = cwd || currentCwd;
    const result = await dialog.showOpenDialog(win, {
      title: folder ? 'Choose a folder to protect' : 'Choose files to protect',
      defaultPath: root,
      properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return { paths: [] };
    const paths = [];
    const outside = [];
    for (const abs of result.filePaths) {
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) outside.push(path.basename(abs));
      else paths.push(rel.split(path.sep).join('/'));
    }
    return { paths, outside };
  });
  ipcMain.handle('perm:act', async (_e, { action, kind, value, scope, mode, cwd }) => {
    const tr = await turnRunner();
    const session = await ensureSession();
    const target = cwd || session.cwd;
    const actions = {
      add: () => tr.addPermission(session, kind, value ?? '', scope, target),
      remove: () => tr.removePermission(session, kind, value, scope, target),
      move: () => tr.movePermission(session, kind, value, scope, target),
      revoke: () => tr.revokeSessionGrant(session, kind, value),
      setMode: () => tr.setDefaultMode(session, scope, mode ?? null, target),
    };
    const run = actions[action];
    const result = run ? await run() : { ok: false, error: `Unknown action: ${action}` };
    return { result, ...(await permPayload(tr, session, target)) };
  });

  // Usage > Context: the user's own auto-compaction bar, for this project or for
  // every project. Same project-picker shape as Rules & Skills and Permissions —
  // `cwd` is whichever project the scope dropdown has selected, the open one when
  // omitted — and every action returns the fresh view to redraw from.
  async function ctxPayload(tr, session, cwd) {
    const projects = projectsForPicker();
    return { view: await tr.contextView(session, cwd || session.cwd), projects };
  }
  ipcMain.handle('ctx:get', async (_e, cwd) => {
    const tr = await turnRunner();
    return ctxPayload(tr, await ensureSession(), cwd);
  });
  ipcMain.handle('ctx:act', async (_e, { action, scope, tokens, cwd }) => {
    const tr = await turnRunner();
    const session = await ensureSession();
    const target = cwd || session.cwd;
    const actions = {
      set: () => tr.setContextOverride(session, scope, tokens, target),
      reset: () => tr.resetContextOverride(session, scope, target),
    };
    const run = actions[action];
    const result = run ? await run() : { ok: false, error: `Unknown action: ${action}` };
    // The chat header's context meter reads the ACTIVE session's own bar, which only
    // just changed if this write reaches it: a global override reaches every session,
    // a project one only the session actually open on that project. Otherwise the
    // meter would sit on its old number until the next turn happened to refresh it.
    if (result.ok && (scope === 'global' || target === session.cwd)) void sendContext();
    return { result, ...(await ctxPayload(tr, session, target)) };
  });

  // Usage > Spend: tokens billed so far, across every project — read-only, tokens
  // only (no dollar figure yet; see core/spendView.ts). Scans every session's meta
  // file on disk, which is cheap per file but adds up across many sessions, so the
  // result is cached until the page explicitly asks to refresh rather than re-scanned
  // on every render.
  let spendCache = null;
  // Usage limits: the rules live in the core; these only hand its answers to the settings page.
  ipcMain.handle('limits:get', async (_e, { force } = {}) => (await turnRunner()).limitsView(!!force));
  ipcMain.handle('limits:save', async (_e, patch) => (await turnRunner()).saveLimitsFromPanel(patch || {}));
  ipcMain.handle('limits:analyze', async (_e, input) => (await turnRunner()).analyzeForPanel(input || {}));

  ipcMain.handle('spend:get', async (_e, { force } = {}) => {
    if (!spendCache || force) {
      const tr = await turnRunner();
      spendCache = await tr.spendView();
    }
    return spendCache;
  });

  // The unsent message, per project: text plus attachments, written moments after
  // every change so a restart or a crash never loses it. Its own file, because it is
  // written far more often than the rest of the desktop state.
  const DRAFTS_FILE = path.join(app.getPath('userData'), 'drafts.json');
  const readDrafts = () => readStateFile(DRAFTS_FILE) || readStateFile(`${DRAFTS_FILE}.bak`) || {};
  ipcMain.handle('draft:get', (_e, cwd) => {
    const d = readDrafts()[cwd || currentCwd];
    if (!d) return null;
    // Files that were deleted or moved since can't be attached any more; say which.
    const attachments = (d.attachments || []).filter((a) => a.kind === 'paste' || (a.path && fs.existsSync(a.path)));
    return { text: d.text || '', attachments, missing: (d.attachments || []).length - attachments.length };
  });
  function saveDraftFor({ cwd, draft }) {
    const all = readDrafts();
    const key = cwd || currentCwd;
    if (draft && (draft.text?.trim() || draft.attachments?.length)) all[key] = draft;
    else delete all[key];
    try {
      writeJsonAtomic(DRAFTS_FILE, all);
    } catch { /* best effort: the draft is still in the box */ }
    return true;
  }
  ipcMain.handle('draft:set', (_e, arg) => saveDraftFor(arg));
  // Written before the call returns: for the moment the window is closing.
  ipcMain.on('draft:setSync', (e, arg) => { e.returnValue = saveDraftFor(arg); });

  // Quick tabs: what the user pinned to the chat header, kept across launches.
  // Keys: 'mode', 'mcp:<server>', 'rs:<file>'. Mode is pinned until removed.
  ipcMain.handle('qt:get', () => {
    const pins = loadDesktopState().quickTabs;
    return Array.isArray(pins) ? pins : ['mode'];
  });
  ipcMain.handle('qt:set', (_e, pins) => {
    const state = loadDesktopState();
    state.quickTabs = Array.isArray(pins) ? pins.filter((k) => typeof k === 'string').slice(0, 20) : ['mode'];
    saveDesktopState(state);
    return state.quickTabs;
  });

  // Rules and skills: plain files, listed and edited as text.
  // Every call takes `cwd`: the project picked in the page's list (the open one when
  // absent). The list response carries the projects to pick from.
  async function rsPayload(tr, session, cwd) {
    const projects = projectsForPicker();
    return { items: await tr.listRulesSkills(session, cwd || session.cwd), projects };
  }
  ipcMain.handle('rs:list', async (_e, cwd) => {
    const tr = await turnRunner();
    return rsPayload(tr, await ensureSession(), cwd);
  });
  ipcMain.handle('rs:read', async (_e, { file, cwd }) => {
    const session = await ensureSession();
    return (await turnRunner()).readRuleSkill(session, file, cwd || session.cwd);
  });
  // Upload or drop: the page reads each file and sends its name and text; each is
  // added as a rule or skill by what it is. One result per file, in order.
  ipcMain.handle('rs:import', async (_e, { files, scope, cwd }) => {
    const tr = await turnRunner();
    const session = await ensureSession();
    const target = cwd || session.cwd;
    const results = [];
    for (const f of files || []) {
      results.push({ name: f.name, ...(await tr.importRuleSkill(session, f.name, f.text ?? '', scope, target)) });
    }
    return { results, ...(await rsPayload(tr, session, target)) };
  });
  ipcMain.handle('rs:act', async (_e, { action, file, text, kind, name, scope, cwd }) => {
    const tr = await turnRunner();
    const session = await ensureSession();
    const target = cwd || session.cwd;
    const actions = {
      save: () => tr.saveRuleSkill(session, file, text ?? '', target),
      create: () => tr.createRuleSkill(session, kind, name ?? '', scope, target),
      remove: () => tr.deleteRuleSkill(session, file, target),
      move: () => tr.moveRuleSkill(session, file, target),
    };
    const run = actions[action];
    const result = run ? await run() : { ok: false, error: `Unknown action: ${action}` };
    return { result, ...(await rsPayload(tr, session, target)) };
  });

  // MCP servers for the active session: the same writes the CLI's /mcp box makes,
  // applied to the running pool at once.
  ipcMain.handle('mcp:list', async () => (await turnRunner()).listMcpServers(await ensureSession()));
  ipcMain.handle('mcp:detail', async (_e, name) => (await turnRunner()).mcpServerDetail(await ensureSession(), name));
  ipcMain.handle('mcp:act', async (_e, { action, name, form }) => {
    const tr = await turnRunner();
    const session = await ensureSession();
    const actions = {
      save: () => tr.saveMcpServer(session, form),
      remove: () => tr.removeMcpServer(session, name),
      disable: () => tr.setMcpServerDisabled(session, name, true),
      enable: () => tr.setMcpServerDisabled(session, name, false),
      reconnect: () => tr.reconnectMcpServer(session, name),
      // The sign-in page opens in the browser; the URL also goes back to the page in
      // case no browser comes up.
      signIn: () => tr.signInMcpServer(session, name, (url) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        if (!win.isDestroyed()) win.webContents.send('mcp:signInUrl', { name, url });
      }),
      signOut: () => tr.signOutMcpServer(session, name),
      allowChanged: () => tr.allowChangedMcpTools(session),
    };
    const run = actions[action];
    const result = run ? await run() : { ok: false, error: `Unknown action: ${action}` };
    return { result, servers: await tr.listMcpServers(session) };
  });

  // One provider's models with prices, straight from the engine's rate tables.
  ipcMain.handle('providers:detail', async (_event, id) => (await turnRunner()).providerDetail(id));

  ipcMain.handle('providers:setKey', async (_event, { apiKeyEnv, key }) => {
    const { setProviderKey, providerSummaries } = await turnRunner();
    setProviderKey(apiKeyEnv, key);
    return providerSummaries();
  });

  ipcMain.handle('providers:clearKey', async (_event, apiKeyEnv) => {
    const { clearProviderKey, providerSummaries } = await turnRunner();
    clearProviderKey(apiKeyEnv);
    return providerSummaries();
  });

  // Sends are handled strictly one after another. Preparing a message is async
  // (attached files are read, images checked), and without this chain two quick
  // sends could both see "no turn running" and start two overlapping turns —
  // tool rows from one left stuck "running…" by the other.
  let sendChain = Promise.resolve();
  ipcMain.on('chat:send', (_event, { text, filePaths = [], pastes = [], marathon = false }) => {
    sendChain = sendChain.then(async () => {
      const { runTurn, prepareMessage, startMarathonRun } = await turnRunner();
      const session = await ensureSession();
      // Files and pastes resolved exactly as the CLI resolves them (see
      // prepareMessage in turnRunner.ts); the chat shows the typed form.
      const prepared = await prepareMessage(session, { text, filePaths, pastes }, sendEvent);
      if (turnRunning) {
        // Same rule as the CLI's own queue: recorded now, in the order typed,
        // and handed to the turn at its next step boundary.
        prepared.qid = ++queueSeq;
        prepared.priority = interrupting ? 'now' : 'next';
        prepared.raw = { text, filePaths, pastes }; // what ↑ gives back to edit
        steerQueue.push(prepared);
        sendQueue();
        return;
      }
      turnRunning = true; // claimed before this link of the chain ends
      sendEvent({ type: 'userMessage', text: prepared.displayText, images: prepared.imagePaths, files: prepared.files });
      // Marathon armed: this message is the goal, and it runs (asking its questions first,
      // then on its own) until it is done, stuck, or stopped. Only ever a fresh start:
      // a message queued into a running turn stays an ordinary message.
      void runOneTurn((handlers) =>
        marathon
          ? startMarathonRun(session, { content: prepared.content, images: prepared.images }, handlers)
          : runTurn(session, { content: prepared.content, images: prepared.images }, handlers),
      );
    }).catch((error) => {
      sendEvent({ type: 'error', text: String(error?.message ?? error) });
    });
  });

  // ── Marathon: carry on / dismiss / read back a run ────────────────────
  // The state itself lives on the session (and is saved with it); these are only the
  // buttons on the checklist box and the way the box finds a run again after a reload.
  ipcMain.handle('marathon:get', async () => {
    if (!activeSession) return null;
    const { marathonOf } = await turnRunner();
    const m = marathonOf(activeSession);
    return m ? { status: m.status, goal: m.goal, turnsSpent: m.turnsSpent, todos: m.todos ?? [] } : null;
  });
  ipcMain.handle('marathon:resume', async () => {
    if (turnRunning || !activeSession) return { ok: false };
    const session = activeSession;
    const { resumeMarathonRun, marathonOf } = await turnRunner();
    if (marathonOf(session)?.status !== 'running') return { ok: false };
    turnRunning = true;
    void runOneTurn((handlers) => resumeMarathonRun(session, handlers));
    return { ok: true };
  });
  ipcMain.handle('marathon:clear', async () => {
    if (turnRunning || !activeSession) return { ok: false };
    const { dismissMarathon } = await turnRunner();
    await dismissMarathon(activeSession); // saved too, so it stays closed on reopen
    return { ok: true };
  });

  // A dropped file that has no path on disk (a photo dragged out of a browser)
  // is written to a temp file, so it can be attached like any other.
  const DROP_DIR = path.join(app.getPath('temp'), 'mwcode-drops');
  const DROP_MAX = 25 * 1024 * 1024;
  ipcMain.handle('file:saveTemp', async (_e, { name, bytes }) => {
    if (!bytes || bytes.length > DROP_MAX) throw new Error('too large to attach');
    await fs.promises.mkdir(DROP_DIR, { recursive: true });
    const safe = String(name || 'dropped').replace(/[^\w.\- ]+/g, '_').slice(-80) || 'dropped';
    const file = path.join(DROP_DIR, `${Date.now()}-${safe}`);
    await fs.promises.writeFile(file, Buffer.from(bytes));
    return file;
  });

  // A file dropped anywhere the page didn't handle would navigate the window to
  // it and replace the whole app. The page swallows drops; this is the backstop.
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // A file's contents for the attachment preview. Text only, and bounded: this
  // is a look before sending, not a file viewer.
  ipcMain.handle('file:peek', async (_e, filePath) => {
    try {
      const st = await fs.promises.stat(filePath);
      const MAX = 256 * 1024;
      const fh = await fs.promises.open(filePath, 'r');
      const buf = Buffer.alloc(Math.min(st.size, MAX));
      await fh.read(buf, 0, buf.length, 0);
      await fh.close();
      const binary = buf.includes(0);
      return { size: st.size, binary, text: binary ? '' : buf.toString('utf8'), clipped: st.size > MAX };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  });

  // ── Rewind: back to before one of your messages, files included ──────
  // The core's rewind (memory/rewind.ts), the same one the CLI's /rewind uses. Only
  // between turns: a turn in flight is still writing the conversation being cut.
  ipcMain.handle('rewind:points', async () => {
    const session = await ensureSession();
    const { rewindPoints } = await turnRunner();
    return rewindPoints(session);
  });
  ipcMain.handle('rewind:to', async (_e, { at, mode = 'both' }) => {
    if (turnRunning) return { error: 'Stop the agent first. Rewinding happens between turns.' };
    const session = await ensureSession();
    const { rewindTo, replayHistory } = await turnRunner();
    const r = await rewindTo(session, at, mode);
    if (!r) return { error: "That message isn't in the conversation any more." };
    return { ...r, replay: replayHistory(session) };
  });

  // A test's recording, for replay: frames as file paths with the time each was drawn.
  ipcMain.handle('rec:get', async (_e, live) => recorder.get(live));

  // A path the agent wrote, as a place on disk: `~`, %VAR% and $env:VAR expanded, relative to
  // the open project, a trailing :line kept apart. Null when it is not a path at all.
  function resolveSpoken(text) {
    let p = String(text || '').trim().replace(/^["'`]|["'`]$/g, '');
    let line;
    const at = /^(.*?[^:]):(\d+)(?::\d+)?$/.exec(p);
    if (at && !/^[A-Za-z]$/.test(at[1])) { p = at[1]; line = Number(at[2]); }
    p = p
      .replace(/^~(?=[\\/]|$)/, os.homedir())
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, v) => process.env[v] ?? m)
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, v) => process.env[v] ?? m);
    if (!p || /[<>|?*"]/.test(p.replace(/^[A-Za-z]:/, ''))) return null;
    return { full: path.isAbsolute(p) ? path.normalize(p) : path.join(currentCwd, p), line };
  }

  // Which of the paths in an agent's reply are real, so only those become clickable.
  ipcMain.handle('paths:check', async (_e, list) => {
    const out = {};
    for (const text of (Array.isArray(list) ? list : []).slice(0, 80)) {
      const r = resolveSpoken(text);
      if (!r) continue;
      try {
        const st = await fs.promises.stat(r.full);
        out[text] = { full: r.full, line: r.line, kind: st.isDirectory() ? 'dir' : 'file' };
      } catch { /* not there: stays plain text */ }
    }
    return out;
  });

  // The other ways to open something: its own Windows app (a page in the browser), or its folder.
  ipcMain.handle('file:openWith', async (_e, full, how) => {
    if (!fs.existsSync(full)) return { error: 'That is not there any more.' };
    if (how === 'reveal') { shell.showItemInFolder(full); return { ok: true }; }
    const problem = await shell.openPath(full);
    return problem ? { error: problem } : { ok: true };
  });

  // A file from the chat (an edit, a write, a read) in the user's own editor. Never wakes the agent.
  // A folder opens in the editor as a folder.
  ipcMain.handle('file:open', async (_e, filePath, line) => {
    const full = path.isAbsolute(filePath) ? filePath : path.join(currentCwd, filePath);
    if (!fs.existsSync(full)) return { error: 'That file is not there any more.' };
    const editor = findEditorLauncher();
    if (editor) {
      const isDir = fs.statSync(full).isDirectory();
      const at = !isDir && Number.isInteger(line) && line > 0 ? `${full}:${line}` : full;
      const args = isDir ? [at] : ['-g', at];
      const child = require('child_process').spawn(editor.exe, editor.cli ? [editor.cli, ...args] : args, {
        env: editor.cli ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => {});
      child.unref();
      return { ok: true };
    }
    const problem = await shell.openPath(full);
    return problem ? { error: problem } : { ok: true };
  });

  // Esc: absolute, as in the CLI. The turn stops, a question it was waiting on is
  // answered "no", and everything it has running stops with it: background commands
  // (so any app one launched), the app being tested and its live view.
  // Answer the message already in the conversation, adding nothing: for a message that was sent but got no
  // reply (the app closed, the send failed). The model reads it as the latest thing said.
  ipcMain.handle('chat:continue', async () => {
    if (turnRunning) return false;
    const session = await ensureSession();
    const last = session.transcript[session.transcript.length - 1];
    if (!last || last.role !== 'user') return false; // only an unanswered message
    const { continueTurn } = await turnRunner();
    turnRunning = true;
    void runOneTurn((handlers) => continueTurn(session, handlers));
    return true;
  });

  ipcMain.on('chat:cancel', async () => {
    abortController?.abort();
    if (turnRunning) interrupting = true; // typed from here on, the stop was for it
    if (pendingApprovals.size) {
      for (const resolve of pendingApprovals.values()) resolve(undefined);
      pendingApprovals.clear();
      sendEvent({ type: 'approvalsDismissed' });
    }
    if (activeSession) {
      const { stopEverything } = await turnRunner();
      await stopEverything(activeSession).catch(() => {});
    }
  });

  // ── Background shells: what the CLI shows as its [BG] bar and /shells ──
  // Plain data only crosses to the renderer; the manager stays in this process.
  function shellView(sh) {
    return {
      id: sh.id, command: sh.command, status: sh.status, exitCode: sh.exitCode,
      signal: sh.signal ?? null, startedAt: sh.startedAt, finishedAt: sh.finishedAt,
      port: sh.port ?? null, stoppedBy: sh.stoppedBy ?? null, stalled: sh.stallReason ?? null,
    };
  }
  function listShells(session = activeSession) {
    return (session?.toolContext.backgroundShells?.list() ?? []).map(shellView);
  }
  function sendShells(session = activeSession) {
    if (!win.isDestroyed()) win.webContents.send('shells:changed', listShells(session));
  }
  ipcMain.handle('shells:list', () => listShells());

  // The Run button. Its running state is derived from the shell list (a running
  // shell with the detected command), never tracked separately, so it cannot
  // disagree with the shells chip or survive a session switch it shouldn't.
  // A command the user typed for this project wins over the detected one, and is
  // used from then on; removing it goes back to detection.
  function customRun(cwd) {
    const saved = (loadDesktopState().runCommands || {})[cwd];
    if (!saved?.command) return null;
    const dirAbs = saved.dir ? path.resolve(cwd, saved.dir) : cwd;
    return { command: saved.command, kind: 'your command', custom: true, ...(saved.dir ? { dir: saved.dir, cwd: dirAbs } : {}) };
  }
  function runTarget(cwd) {
    return customRun(cwd) ?? detectRun(cwd);
  }
  ipcMain.handle('run:status', () => {
    if (!hasProject()) return null;
    const detected = detectRun(currentCwd);
    const custom = customRun(currentCwd);
    return custom ? { ...custom, detected } : detected ? { ...detected, detected } : null;
  });
  ipcMain.handle('run:set', (_e, { command, dir }) => {
    const cmd = typeof command === 'string' ? command.trim() : '';
    const sub = typeof dir === 'string' ? dir.trim().replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '') : '';
    if (!cmd) return { error: 'Type the command that starts your app.' };
    if (sub) {
      const abs = path.resolve(currentCwd, sub);
      const rel = path.relative(currentCwd, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'The folder has to be inside the project.' };
      if (!fs.existsSync(abs)) return { error: `There's no folder called ${sub} in this project.` };
    }
    const state = loadDesktopState();
    state.runCommands = { ...(state.runCommands || {}), [currentCwd]: { command: cmd, ...(sub ? { dir: sub } : {}) } };
    saveDesktopState(state);
    return { ok: true };
  });
  ipcMain.handle('run:clear', () => {
    const state = loadDesktopState();
    if (state.runCommands) delete state.runCommands[currentCwd];
    saveDesktopState(state);
    return { ok: true };
  });
  ipcMain.handle('run:toggle', async () => {
    const target = runTarget(currentCwd);
    if (!target) return { error: 'Nothing to run in this project.' };
    const session = await ensureSession();
    const mgr = session.toolContext.backgroundShells;
    const live = mgr?.list().find((sh) => sh.status === 'running' && sh.command === target.command);
    if (live) {
      mgr.kill(live.id, 'user');
      return { stopped: live.id };
    }
    const { startUserCommand } = await turnRunner();
    const started = await startUserCommand(session, target.command, target.cwd);
    sendShells(session);
    return started;
  });
  // `user`, so the agent is told YOU stopped it rather than guessing it crashed.
  ipcMain.handle('shells:kill', (_e, id) => activeSession?.toolContext.backgroundShells?.kill(id, 'user') ?? false);
  // peek, never read: looking at the log must not take output away from the agent.
  ipcMain.handle('shells:log', async (_e, id) => {
    const r = await activeSession?.toolContext.backgroundShells?.peek(id);
    return r ? { tail: r.tail, clipped: r.clipped, shell: shellView(r.info) } : null;
  });

  ipcMain.on('approval:respond', (_event, { id, choice }) => {
    const resolve = pendingApprovals.get(id);
    if (!resolve) return;
    pendingApprovals.delete(id);
    resolve(choice);
  });
}

// Messages that were waiting in the queue when the app died go back into that project's message box.
function restoreQueuedMessages() {
  const file = path.join(app.getPath('userData'), 'queued-messages.json');
  const q = readStateFile(file);
  if (!q || !Array.isArray(q.items) || !q.items.length || typeof q.cwd !== 'string') return;
  const draftsFile = path.join(app.getPath('userData'), 'drafts.json');
  const all = readStateFile(draftsFile) || readStateFile(`${draftsFile}.bak`) || {};
  const have = all[q.cwd] || { text: '', attachments: [] };
  const typed = q.items.map((i) => String(i.text || '')).filter((t) => t.trim());
  const attachments = [...(have.attachments || [])];
  for (const i of q.items) {
    for (const p of i.pastes || []) attachments.push({ kind: 'paste', name: 'Pasted text', text: String(p) });
    for (const f of i.filePaths || []) attachments.push({ kind: /\.(png|jpe?g|gif|webp)$/i.test(f) ? 'image' : 'file', name: path.basename(f), path: f });
  }
  all[q.cwd] = { text: [have.text || '', ...typed].filter((t) => t.trim()).join('\n\n'), attachments };
  try {
    writeJsonAtomic(draftsFile, all);
    for (const f of [file, `${file}.bak`, `${file}.tmp`]) fs.rmSync(f, { force: true });
  } catch { /* the queue file stays and is tried again next time */ }
}

// The app's own identity on the Windows taskbar: its own button and icon, not grouped under Electron.
if (process.platform === 'win32') app.setAppUserModelId('com.mindweave.mwcode');
app.setName('mwcode');

// Theme: 'system' (the default: follows Windows), 'light' or 'dark'. nativeTheme.themeSource is what the
// page's prefers-color-scheme follows, so this one setting drives every colour.
const THEMES = ['system', 'light', 'dark'];
function savedTheme() { const t = loadDesktopState().theme; return THEMES.includes(t) ? t : 'system'; }
const windowColour = () => (nativeTheme.shouldUseDarkColors ? '#080A09' : '#D6DCD8');

let feedReady;
const feedService = new Promise((resolve) => { feedReady = resolve; });
// macOS: the mw command. The zip has no installer to put it on the PATH (the Windows installer and the
// Linux package do), so Settings > About offers it: two links in /usr/local/bin, which every Mac has on
// its PATH, made through the system's own password prompt. Only from Applications: an app opened
// straight from Downloads runs from a temporary copy that disappears, and the links with it.
const CLI_DIR = '/usr/local/bin';
function cliState() {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const own = path.join(process.resourcesPath, 'bin', 'mw');
  let linked = null;
  try { linked = fs.realpathSync(path.join(CLI_DIR, 'mw')); } catch { /* not there */ }
  let ownReal = own;
  try { ownReal = fs.realpathSync(own); } catch { /* keep */ }
  return { installed: linked === ownReal, temporary: process.resourcesPath.includes('/AppTranslocation/') };
}
ipcMain.handle('cli:state', () => cliState());
ipcMain.handle('cli:install', () => new Promise((resolve) => {
  const state = cliState();
  if (!state) return resolve({ state, error: null });
  if (state.temporary) return resolve({ state, error: 'Move mwcode to Applications first, then open it from there.' });
  const bin = path.join(process.resourcesPath, 'bin');
  const q = (p) => `'${p.replace(/'/g, "'\\''")}'`;
  const sh = `mkdir -p ${CLI_DIR} && ln -sf ${q(bin + '/mw')} ${CLI_DIR}/mw && ln -sf ${q(bin + '/mindweave')} ${CLI_DIR}/mindweave`;
  const script = `do shell script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
  require('child_process').execFile('/usr/bin/osascript', ['-e', script], (err) => {
    const cancelled = err && /-128|User canceled/i.test(String(err.message || err));
    resolve({ state: cliState(), error: err && !cancelled ? 'Could not add it. Try again, or link it yourself: ' + bin + '/mw' : null });
  });
}));

ipcMain.handle('feed:get', async () => (await feedService).get());
ipcMain.handle('feed:refresh', async () => (await feedService).refresh());
ipcMain.handle('feed:markRead', async (_e, ids) => (await feedService).markRead(Array.isArray(ids) ? ids.slice(0, 100) : []));

app.whenReady().then(async () => {
  nativeTheme.themeSource = savedTheme();
  // Windows switched between light and dark while the app is open: the window background follows.
  nativeTheme.on('updated', () => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !ROUND_IN_PAGE) w.setBackgroundColor(windowColour()); });
  const core = turnRunner(); // starts loading now; the window does not wait for it
  // Before the window exists: its page asks for what it remembered the instant it loads.
  restoreQueuedMessages();
  uiStore = createUiStore(path.join(app.getPath('userData'), 'ui-state.json'));
  ipcMain.on('store:load', (e) => { e.returnValue = uiStore.all(); });
  ipcMain.on('store:set', (e, k, v) => { e.returnValue = uiStore.set(k, v); });
  // Updates: the window only ever sees this small state and asks for the next step.
  ipcMain.handle('update:get', () => (updater ? updater.get() : { status: 'none', mode: 'none' }));
  ipcMain.handle('update:check', () => (updater ? updater.check({ force: true }) : { status: 'none', mode: 'none' }));
  ipcMain.handle('update:start', () => (updater ? updater.download() : { status: 'none', mode: 'none' }));
  ipcMain.handle('update:restart', () => (updater ? updater.restart() : { status: 'none', mode: 'none' }));

  ipcMain.on('store:remove', (e, k) => { e.returnValue = uiStore.remove(k); });
  createWindow();
  void recorder.prune(); // old recordings, in the background

  const { sendAnalyticsPing, appVersion } = await core;
  // The same launch ping the CLI sends: a random id and the version, nothing else,
  // a no-op while the count is paused in the core. Fire and forget.
  sendAnalyticsPing(appVersion());

  newsFeed = createFeedService({
    dir: app.getPath('userData'),
    versions: () => ({ app: app.getVersion(), core: appVersion(), cli: appVersion() }),
    publicKey: NEWS_PUBLIC_KEY,
    onUpdate: (result) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('feed:updated', result);
    },
  });
  feedReady(newsFeed);
  newsFeed.start();

  updater = createUpdateService({
    dir: app.getPath('userData'),
    current: app.getVersion(),
    publicKey: UPDATE_PUBLIC_KEY,
    packaged: app.isPackaged,
    onChange: (state) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:changed', state);
    },
    // The installer or swap script waits for this process to be gone, so it really quits (the Mac red
    // button only hides the window).
    quit: () => { quitting = true; app.quit(); },
  });
  updater.start();

  // macOS: the menu bar, without which Cmd+C, Cmd+V, Cmd+Q and the rest do nothing.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
  }
  // The Dock icon clicked: the hidden window comes back (a new one only if there is none).
  app.on('activate', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.show(); else createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
