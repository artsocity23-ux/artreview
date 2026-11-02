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
let pendingFile = SELFTEST ? null : fileFromArgs(process.argv);
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

function fileFromArgs(argv) {
  return argv.slice(1).find(a => OPENABLE.test(a) && fs.existsSync(a)) || null;
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
    for (const fd of fds.values()) fs.closeSync(fd);
    fds.clear();
  });
}

// ---------- file access ----------

const FILTERS = {
  video: [{ name: 'Відео', extensions: VIDEO_EXT }],
  review: [{ name: 'Нотатки ArtReview', extensions: ['artreview'] }],
};

let lastDir = app.getPath('documents');

ipcMain.handle('ar:open-dialog', async (e, kind) => {
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

ipcMain.handle('ar:save-dialog', async (e, kind, name) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Зберегти нотатки',
    defaultPath: path.join(lastDir, name || 'notes.artreview'),
    filters: FILTERS[kind] || FILTERS.review,
  });
  if (canceled || !filePath) return null;
  lastDir = path.dirname(filePath);
  return filePath;
});

ipcMain.handle('ar:folder-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Папка для відео з нотатками',
    defaultPath: settings.outDir || defaultOutDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('ar:read', (e, file) => fs.promises.readFile(file));
ipcMain.handle('ar:write', async (e, file, data) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, data);
  return file;
});
ipcMain.handle('ar:stat', (e, file) => fs.promises.stat(file).then(s => ({ size: s.size, mtime: s.mtimeMs }), () => null));
ipcMain.handle('ar:file-url', (e, file) => pathToFileURL(file).href);
ipcMain.handle('ar:reveal', (e, file) => shell.showItemInFolder(file));

// Byte ranges for the video decoder, so a long video never has to sit in memory as a whole.
const fds = new Map();
ipcMain.handle('ar:range', async (e, file, start, end) => {
  let fd = fds.get(file);
  if (fd === undefined) {
    fd = fs.openSync(file, 'r');
    fds.set(file, fd);
  }
  const buf = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await new Promise((resolve, reject) =>
    fs.read(fd, buf, 0, buf.length, start, (err, bytesRead) => (err ? reject(err) : resolve({ bytesRead }))));
  return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
});
ipcMain.handle('ar:range-close', (e, file) => {
  const fd = fds.get(file);
  if (fd !== undefined) fs.closeSync(fd);
  fds.delete(file);
});

// ---------- settings, autosave ----------

ipcMain.handle('ar:settings', () => ({ ...settings }));
ipcMain.handle('ar:set-settings', (e, patch) => {
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
ipcMain.handle('ar:default-out-dir', () => defaultOutDir());

// The key comes from the renderer (a hash of the video path and size); the pattern keeps it a plain file name.
function reviewFile(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{8,64}$/.test(key)) throw new Error(`bad review key: ${key}`);
  return path.join(REVIEWS, `${key}.artreview`);
}
ipcMain.handle('ar:review-autosave', (e, key, json) => {
  writeAtomic(reviewFile(key), typeof json === 'string' ? json : JSON.stringify(json));
});
ipcMain.handle('ar:review-autoload', (e, key) => {
  try {
    return fs.readFileSync(reviewFile(key), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log('autoload failed:', err.message);
    return null;
  }
});

// ---------- clipboard, drag-out ----------

ipcMain.handle('ar:copy-video', async (e, file, text) => {
  const r = await copyVideo(file, text);
  log(`copy video ${file}: ${r.ok ? (r.withText ? 'file + text' : 'file') : `failed (${r.error})`}`);
  return { ok: r.ok, withText: r.withText };
});
ipcMain.handle('ar:copy-text', (e, text) => clipboard.writeText(String(text ?? '')));

let dragIcon = null;
ipcMain.on('ar:drag-out', (e, file) => {
  if (!file || !fs.existsSync(file)) return;
  // startDrag needs a non-empty icon (macOS throws without one).
  dragIcon ||= nativeImage.createFromPath(path.join(ROOT, 'icon.png')).resize({ width: 48, height: 48 });
  e.sender.startDrag({ file, icon: dragIcon });
});

// ---------- misc ----------

ipcMain.on('ar:env', e => {
  e.returnValue = { selftest: SELFTEST, version: app.getVersion(), platform: process.platform };
});
ipcMain.handle('ar:pending-file', () => {
  const file = pendingFile;
  pendingFile = null;
  return file;
});
ipcMain.on('ar:set-title', (e, title) => win?.setTitle(String(title || 'ArtReview')));
ipcMain.on('ar:log', (e, ...parts) => log(...parts));

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

ipcMain.handle('ar:donate-available', () => donateCrypto.length + donateLinks.length > 0);
ipcMain.on('ar:donate-open-window', () => openDonate());
ipcMain.handle('ar:donate', () => ({
  crypto: donateCrypto.map(c => ({ name: c.name, network: c.network, address: c.address, qr: qrDataURL(c.address) })),
  links: donateLinks.map(l => l.name),
}));
ipcMain.handle('ar:donate-copy', (e, i) => clipboard.writeText(donateCrypto[i]?.address || ''));
ipcMain.on('ar:donate-open', (e, i) => donateLinks[i] && shell.openExternal(donateLinks[i].url));
ipcMain.on('ar:donate-ready', (e, height) => {
  if (!donateWin || donateWin.isDestroyed() || e.sender !== donateWin.webContents) return;
  const { workArea } = screen.getDisplayMatching(donateWin.getBounds());
  donateWin.setContentSize(480, Math.min(Math.ceil(height), workArea.height - 40));
  donateWin.center();
  donateWin.show();
});

// ---------- lifecycle ----------

nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('io.github.artsocity23ux.artreview');

// One window: a video double-clicked in Explorer while ArtReview runs opens in the running window.
// The self-test may run next to a normal instance, so it skips the lock.
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const file = fileFromArgs(argv);
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
