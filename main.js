const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, screen, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const qrcode = require('qrcode-generator');
const { copyVideo } = require('./clipboard');

const ROOT = __dirname;
// The self-test drives the app itself: default settings, no dialogs, nothing written outside its folder.
const SELFTEST = process.argv.includes('--selftest');
// An installed build keeps the log, settings and autosaves in the per-user app data folder, a source checkout beside the code.
const DATA = app.isPackaged ? app.getPath('userData') : ROOT;
const LOG = path.join(DATA, 'artreview.log');
const OUT = SELFTEST ? path.resolve(process.argv[process.argv.indexOf('--selftest') + 1] || 'selftest-out') : null;
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const REVIEWS = SELFTEST ? path.join(OUT, 'reviews') : path.join(DATA, 'reviews');

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
const OPENABLE = new RegExp(`\\.(artreview|${VIDEO_EXT.join('|')})$`, 'i');

const DEFAULT_SETTINGS = { outDir: null, maxSize: 1920, endCard: true, hud: true, audio: true, startFrame: 1, copyTextWithVideo: true };

// Donation options live in donate.json; entries left empty are not shown.
const donate = readJSON(path.join(ROOT, 'donate.json'));
const donateCrypto = (donate.crypto || []).filter(c => c.address);
const donateLinks = (donate.links || []).filter(l => /^https:\/\//.test(l.url || ''));

let win = null;
let pendingFile = SELFTEST ? null : fileFromArgs(process.argv, process.cwd());
let settings = SELFTEST ? { ...DEFAULT_SETTINGS } : cleanSettings(readJSON(SETTINGS_FILE));

function log(...parts) {
  if (SELFTEST) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, `${LOG}.old`);
    fs.appendFileSync(LOG, `${new Date().toLocaleString('sv')} ${parts.join(' ')}\n`);
  } catch {
    // logging is best effort
  }
}

process.on('uncaughtException', err => log('ERROR', err.stack || err));
process.on('unhandledRejection', err => log('ERROR', err?.stack || err));

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Relative arguments belong to the folder the command was typed in (for a second instance, its folder, not ours).
// The renderer gets an absolute path, so the autosave key of a video does not depend on how it was named.
function fileFromArgs(argv, cwd) {
  for (const a of argv.slice(1)) {
    if (!OPENABLE.test(a)) continue;
    const file = path.resolve(cwd || process.cwd(), a);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------- settings ----------

// Only known keys of the right type survive, so a hand-edited or older settings.json cannot break the renderer.
// maxSize 0 means "original size".
function cleanSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k === 'outDir') s.outDir = typeof v === 'string' && v ? v : null;
    else if (k === 'maxSize') s.maxSize = v === null || v === 0 ? 0 : Number.isFinite(v) && v > 0 ? Math.round(v) : s.maxSize;
    else if (k === 'startFrame') s.startFrame = Number.isInteger(v) && v >= 0 ? v : s.startFrame;
    else if (typeof v === 'boolean') s[k] = v;
  }
  return s;
}

function defaultOutDir() {
  if (SELFTEST) return path.join(OUT, 'ArtReview');
  let videos;
  try {
    videos = app.getPath('videos');
  } catch {
    videos = path.join(app.getPath('home'), 'Videos'); // some Linux desktops have no XDG videos folder
  }
  return path.join(videos, 'ArtReview');
}

// ---------- who may talk to the main process ----------

const APP_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const DONATE_URL = pathToFileURL(path.join(ROOT, 'donate.html')).href;

// Only the top frame of our own page may use the bridge. A notes file must never be able to bring in a page or a
// frame that reaches files through it (navigation is blocked too; this is the second lock).
function trusted(e, url) {
  const f = e.senderFrame;
  return !!f && !f.parent && String(f.url).split('#')[0] === url;
}
function handle(channel, fn, url = APP_URL) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e, url)) throw new Error(`${channel}: not allowed from this page`);
    return fn(e, ...args);
  });
}
function listen(channel, fn, url = APP_URL) {
  ipcMain.on(channel, (e, ...args) => {
    if (trusted(e, url)) fn(e, ...args);
  });
}

// Our windows show our own pages only: no navigation (a dropped .html, a link, a meta refresh), no popups, no webviews.
function lockDown(contents) {
  contents.on('will-navigate', e => e.preventDefault());
  contents.on('will-frame-navigate', e => e.preventDefault());
  contents.on('will-redirect', e => e.preventDefault());
  contents.on('will-attach-webview', e => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// ---------- window ----------

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: SELFTEST ? 1600 : Math.min(1600, workArea.width),
    height: SELFTEST ? 1000 : Math.min(1000, workArea.height),
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'ArtReview',
    backgroundColor: '#15171c',
    icon: path.join(ROOT, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false, spellcheck: false },
  });
  win.removeMenu();
  lockDown(win.webContents);
  win.loadFile(path.join(ROOT, 'index.html'));
  win.once('ready-to-show', () => {
    if (!SELFTEST && workArea.width <= 1920) win.maximize();
    win.show();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.webContents.on('console-message', e => {
    if (e.level === 'error') log('renderer:', e.message);
  });
  win.webContents.on('render-process-gone', (e, d) => log('renderer gone:', d.reason));
  // No save prompt on close: the renderer autosaves the notes of every video as it goes.
  win.on('closed', () => {
    win = null;
    for (const entry of fds.values()) closeEntry(entry);
    fds.clear();
  });
}

// ---------- file access ----------

const FILTERS = {
  video: [{ name: 'Відео', extensions: VIDEO_EXT }],
  review: [{ name: 'Нотатки ArtReview', extensions: ['artreview'] }],
};

let lastDir = app.getPath('documents');

handle('ar:open-dialog', async (e, kind) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: kind === 'review' ? 'Відкрити нотатки' : 'Відкрити відео',
    defaultPath: lastDir,
    filters: FILTERS[kind] || FILTERS.video,
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  lastDir = path.dirname(filePaths[0]);
  return filePaths[0];
});

handle('ar:save-dialog', async (e, kind, name) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Зберегти нотатки',
    defaultPath: path.join(lastDir, name || 'notes.artreview'),
    filters: FILTERS[kind] || FILTERS.review,
  });
  if (canceled || !filePath) return null;
  lastDir = path.dirname(filePath);
  return filePath;
});

handle('ar:folder-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Папка для відео з нотатками',
    defaultPath: settings.outDir || defaultOutDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

handle('ar:read', (e, file) => fs.promises.readFile(file));
handle('ar:write', async (e, file, data) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, data);
  return file;
});
handle('ar:stat', (e, file) => fs.promises.stat(file).then(s => ({ size: s.size, mtime: s.mtimeMs }), () => null));
handle('ar:file-url', (e, file) => pathToFileURL(file).href);
handle('ar:reveal', (e, file) => shell.showItemInFolder(file));

// Byte ranges for the video decoder, so a long video never has to sit in memory as a whole.
// One descriptor per file, shared by every reader of it (the preview and a running export read the same shot).
// Closing waits for reads still in flight, and a later read opens the file again, so one reader letting go never
// pulls the descriptor from under another (that read would fail with EBADF).
const fds = new Map(); // file -> { fd, busy, closing }
function closeEntry(entry) {
  entry.closing = true;
  if (entry.busy === 0 && entry.fd !== null) {
    fs.close(entry.fd, () => {});
    entry.fd = null;
  }
}
handle('ar:range', async (e, file, start, end) => {
  let entry = fds.get(file);
  if (!entry) {
    entry = { fd: fs.openSync(file, 'r'), busy: 0, closing: false };
    fds.set(file, entry);
  }
  entry.busy++;
  try {
    const buf = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await new Promise((resolve, reject) =>
      fs.read(entry.fd, buf, 0, buf.length, start, (err, bytesRead) => (err ? reject(err) : resolve({ bytesRead }))));
    return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  } finally {
    entry.busy--;
    if (entry.closing) closeEntry(entry);
  }
});
handle('ar:range-close', (e, file) => {
  const entry = fds.get(file);
  fds.delete(file);
  if (entry) closeEntry(entry);
});

// ---------- settings, autosave ----------

handle('ar:settings', () => ({ ...settings }));
handle('ar:set-settings', (e, patch) => {
  settings = cleanSettings({ ...settings, ...patch });
  if (!SELFTEST) {
    try {
      writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (err) {
      log('settings not saved:', err.message);
    }
  }
  return { ...settings };
});
handle('ar:default-out-dir', () => defaultOutDir());

// The key comes from the renderer (a hash of the video path and size); the pattern keeps it a plain file name.
function reviewFile(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{8,64}$/.test(key)) throw new Error(`bad review key: ${key}`);
  return path.join(REVIEWS, `${key}.artreview`);
}
handle('ar:review-autosave', (e, key, json) => {
  writeAtomic(reviewFile(key), typeof json === 'string' ? json : JSON.stringify(json));
});
handle('ar:review-autoload', (e, key) => {
  try {
    return fs.readFileSync(reviewFile(key), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log('autoload failed:', err.message);
    return null;
  }
});

// ---------- clipboard, drag-out ----------

handle('ar:copy-video', async (e, file, text) => {
  const r = await copyVideo(file, text);
  log(`copy video ${file}: ${r.ok ? (r.withText ? 'file + text' : 'file') : `failed (${r.error})`}`);
  return { ok: r.ok, withText: r.withText };
});
handle('ar:copy-text', (e, text) => clipboard.writeText(String(text ?? '')));

let dragIcon = null;
listen('ar:drag-out', (e, file) => {
  if (!file || !fs.existsSync(file)) return;
  // startDrag needs a non-empty icon (macOS throws without one).
  dragIcon ||= nativeImage.createFromPath(path.join(ROOT, 'icon.png')).resize({ width: 48, height: 48 });
  e.sender.startDrag({ file, icon: dragIcon });
});

// ---------- misc ----------

// Harmless facts; answered for every page, because a sync message without an answer would hang the page.
ipcMain.on('ar:env', e => {
  e.returnValue = { selftest: SELFTEST, version: app.getVersion(), platform: process.platform };
});
handle('ar:pending-file', () => {
  const file = pendingFile;
  pendingFile = null;
  return file;
});
listen('ar:set-title', (e, title) => win?.setTitle(String(title || 'ArtReview')));
listen('ar:log', (e, ...parts) => log(...parts));

function openFromOS(file) {
  if (!file || !OPENABLE.test(file)) return;
  if (!win) {
    pendingFile = file;
    return;
  }
  win.webContents.send('ar:open-file', file);
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ---------- donate window ----------

let donateWin = null;

function openDonate() {
  if (donateWin && !donateWin.isDestroyed()) return donateWin.focus();
  donateWin = new BrowserWindow({
    parent: win,
    width: 480,
    height: 640,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Підтримати ArtReview',
    backgroundColor: '#15171c',
    icon: path.join(ROOT, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js') },
  });
  donateWin.removeMenu();
  lockDown(donateWin.webContents);
  donateWin.loadFile(path.join(ROOT, 'donate.html'));
  return donateWin;
}

// Quiet zone of 4 modules, as wallet scanners expect.
function qrDataURL(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 24);
}

handle('ar:donate-available', () => donateCrypto.length + donateLinks.length > 0);
listen('ar:donate-open-window', () => openDonate());
handle('ar:donate', () => ({
  crypto: donateCrypto.map(c => ({ name: c.name, network: c.network, address: c.address, qr: qrDataURL(c.address) })),
  links: donateLinks.map(l => l.name),
}), DONATE_URL);
handle('ar:donate-copy', (e, i) => clipboard.writeText(donateCrypto[i]?.address || ''), DONATE_URL);
listen('ar:donate-open', (e, i) => donateLinks[i] && shell.openExternal(donateLinks[i].url), DONATE_URL);
listen('ar:donate-ready', (e, height) => {
  if (!donateWin || donateWin.isDestroyed() || e.sender !== donateWin.webContents) return;
  const { workArea } = screen.getDisplayMatching(donateWin.getBounds());
  donateWin.setContentSize(480, Math.min(Math.ceil(height), workArea.height - 40));
  donateWin.center();
  donateWin.show();
}, DONATE_URL);

// ---------- lifecycle ----------

nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('io.github.artsocity23ux.artreview');

// One window: a video double-clicked in Explorer while ArtReview runs opens in the running window.
// The self-test may run next to a normal instance, so it skips the lock.
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, workingDirectory) => {
    const file = fileFromArgs(argv, workingDirectory);
    if (file) return openFromOS(file);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('open-file', (e, file) => {
    e.preventDefault();
    openFromOS(file);
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    createWindow();
    log(`start ${app.getVersion()}`);
    if (SELFTEST) {
      fs.mkdirSync(OUT, { recursive: true });
      require('./selftest')({ win, out: OUT }).catch(err => {
        console.error(err);
        app.exit(1);
      });
    }
  });
}
