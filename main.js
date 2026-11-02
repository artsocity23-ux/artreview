const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const qrcode = require('qrcode-generator');

const ROOT = __dirname;
const BENCH = process.argv.includes('--bench');
const DEMO = process.argv.includes('--demo');
// The self-test, the benchmark and the README demo recording drive the app themselves: default prefs, no dialogs.
const SELFTEST = process.argv.includes('--selftest') || BENCH || DEMO;
const IS_MAC = process.platform === 'darwin';
// An installed build keeps the log and the autosave in the per-user app data folder, a source checkout beside the code.
const DATA = app.isPackaged ? app.getPath('userData') : ROOT;
const LOG = path.join(DATA, 'artframes.log');
const testArg = process.argv.indexOf(BENCH ? '--bench' : DEMO ? '--demo' : '--selftest');
const OUT = SELFTEST ? path.resolve(process.argv[testArg + 1] || 'selftest-out') : null;
const AUTOSAVE = SELFTEST ? path.join(OUT, 'autosave.artframes') : path.join(DATA, 'autosave.artframes');

// Donation options live in donate.json; entries left empty are not shown.
const donate = readJSON(path.join(ROOT, 'donate.json'));
const donateCrypto = (donate.crypto || []).filter(c => c.address);
const donateLinks = (donate.links || []).filter(l => /^https:\/\//.test(l.url || ''));

let win = null;
let dirty = false;
let closing = false;
let pendingFile = fileFromArgs(process.argv);

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
  return argv.slice(1).find(a => /\.artframes$/i.test(a) && fs.existsSync(a)) || null;
}

// ---------- window ----------

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: SELFTEST ? 1600 : Math.min(1680, workArea.width),
    height: SELFTEST ? 1000 : Math.min(1040, workArea.height),
    minWidth: 1100,
    minHeight: 620,
    show: false,
    title: 'ArtFrames',
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
  win.on('close', e => {
    if (closing || !dirty || SELFTEST) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Зберегти', 'Не зберігати', 'Скасувати'],
      defaultId: 0,
      cancelId: 2,
      title: 'ArtFrames',
      message: 'Зберегти зміни в проєкті?',
      detail: 'Інакше намальоване після останнього збереження пропаде.',
    });
    if (choice === 0) win.webContents.send('af:save-and-close');
    if (choice === 1) {
      fs.rmSync(AUTOSAVE, { force: true });
      closing = true;
      win.close();
    }
  });
  win.on('closed', () => {
    win = null;
    for (const fd of fds.values()) fs.closeSync(fd);
    fds.clear();
  });
}

// ---------- file access ----------

const FILTERS = {
  project: [{ name: 'Проєкт ArtFrames', extensions: ['artframes'] }],
  reference: [
    { name: 'Картинка або відео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'mp4', 'mov', 'm4v', 'webm', 'mkv'] },
    { name: 'Відео', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] },
    { name: 'Картинка', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
  ],
  gif: [{ name: 'GIF', extensions: ['gif'] }],
  mp4: [{ name: 'Відео MP4', extensions: ['mp4'] }],
  webm: [{ name: 'Відео WebM', extensions: ['webm'] }],
};

let lastDir = app.getPath('documents');

ipcMain.handle('af:open-dialog', async (e, kind) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: kind === 'project' ? 'Відкрити проєкт' : 'Референс: картинка або відео',
    defaultPath: lastDir,
    filters: FILTERS[kind],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  lastDir = path.dirname(filePaths[0]);
  return filePaths[0];
});

ipcMain.handle('af:save-dialog', async (e, kind, name) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: kind === 'project' ? 'Зберегти проєкт' : 'Експорт',
    defaultPath: path.join(lastDir, name),
    filters: FILTERS[kind],
  });
  if (canceled || !filePath) return null;
  lastDir = path.dirname(filePath);
  return filePath;
});

ipcMain.handle('af:folder-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Папка для PNG-кадрів',
    defaultPath: lastDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  lastDir = filePaths[0];
  return filePaths[0];
});

ipcMain.handle('af:read', (e, file) => fs.promises.readFile(file));
ipcMain.handle('af:write', async (e, file, data) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, data);
  return file;
});
ipcMain.handle('af:write-in', async (e, dir, name, data) => {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, data);
  return file;
});
ipcMain.handle('af:stat', (e, file) => fs.promises.stat(file).then(s => ({ size: s.size, mtime: s.mtimeMs }), () => null));
ipcMain.handle('af:file-url', (e, file) => pathToFileURL(file).href);
ipcMain.handle('af:reveal', (e, file) => shell.showItemInFolder(file));

// Byte ranges for the video decoder, so a long video never has to sit in memory as a whole.
const fds = new Map();
ipcMain.handle('af:range', async (e, file, start, end) => {
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
ipcMain.handle('af:range-close', (e, file) => {
  const fd = fds.get(file);
  if (fd !== undefined) fs.closeSync(fd);
  fds.delete(file);
});

// ---------- project files ----------
// A project is one JSON file: settings plus every drawing as base64 PNG. Videos stay where they are (path only),
// a reference picture is embedded so the project still opens on another computer. The own (drawn) reference is
// one more PNG with its visibility and opacity; older files simply have none.

function encodeProject({ meta, frames, refBytes, sketch }) {
  const reference = meta.reference && { ...meta.reference, data: refBytes ? Buffer.from(refBytes).toString('base64') : null };
  return JSON.stringify({
    format: 'artframes',
    version: 1,
    ...meta,
    reference,
    sketch: sketch && { ...sketch, png: Buffer.from(sketch.png).toString('base64') },
    frames: frames.map(f => ({ hold: f.hold, png: f.png ? Buffer.from(f.png).toString('base64') : null })),
  });
}

function decodeProject(text) {
  const data = JSON.parse(text);
  if (data.format !== 'artframes') throw new Error('Це не проєкт ArtFrames');
  const { frames, reference, sketch, ...meta } = data;
  return {
    meta,
    reference: reference && { ...reference, data: reference.data ? Buffer.from(reference.data, 'base64') : null },
    sketch: sketch?.png ? { ...sketch, png: Buffer.from(sketch.png, 'base64') } : null,
    frames: frames.map(f => ({ hold: f.hold, png: f.png ? Buffer.from(f.png, 'base64') : null })),
  };
}

async function writeAtomic(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, text);
  await fs.promises.rename(tmp, file);
}

ipcMain.handle('af:project-save', async (e, file, payload) => {
  await writeAtomic(file, encodeProject(payload));
  fs.rmSync(AUTOSAVE, { force: true });
  log(`saved ${file} (${payload.frames.length} frames)`);
  return file;
});

ipcMain.handle('af:project-load', async (e, file) => {
  const project = decodeProject(await fs.promises.readFile(file, 'utf8'));
  lastDir = path.dirname(file);
  log(`opened ${file} (${project.frames.length} frames)`);
  return project;
});

ipcMain.handle('af:autosave', (e, payload) => writeAtomic(AUTOSAVE, encodeProject(payload)));
ipcMain.handle('af:autosave-info', () => (fs.existsSync(AUTOSAVE) && !SELFTEST ? { mtime: fs.statSync(AUTOSAVE).mtimeMs } : null));
ipcMain.handle('af:autosave-load', async () => decodeProject(await fs.promises.readFile(AUTOSAVE, 'utf8')));
ipcMain.handle('af:autosave-clear', () => fs.rmSync(AUTOSAVE, { force: true }));

ipcMain.on('af:env', e => {
  e.returnValue = { selftest: SELFTEST, version: app.getVersion(), platform: process.platform };
});
ipcMain.handle('af:pending-file', () => {
  const file = pendingFile;
  pendingFile = null;
  return file;
});
ipcMain.on('af:state', (e, state) => {
  dirty = state.dirty;
  win?.setTitle(state.title);
});
ipcMain.on('af:close-now', () => {
  closing = true;
  win?.close();
});
ipcMain.on('af:log', (e, ...parts) => log(...parts));

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
    title: 'Підтримати ArtFrames',
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

ipcMain.handle('af:donate-available', () => donateCrypto.length + donateLinks.length > 0);
ipcMain.on('af:donate-open-window', () => openDonate());
ipcMain.handle('af:donate', () => ({
  crypto: donateCrypto.map(c => ({ name: c.name, network: c.network, address: c.address, qr: qrDataURL(c.address) })),
  links: donateLinks.map(l => l.name),
}));
ipcMain.handle('af:donate-copy', (e, i) => clipboard.writeText(donateCrypto[i]?.address || ''));
ipcMain.on('af:donate-open', (e, i) => donateLinks[i] && shell.openExternal(donateLinks[i].url));
ipcMain.on('af:donate-ready', (e, height) => {
  if (!donateWin || donateWin.isDestroyed() || e.sender !== donateWin.webContents) return;
  const { workArea } = screen.getDisplayMatching(donateWin.getBounds());
  donateWin.setContentSize(480, Math.min(Math.ceil(height), workArea.height - 40));
  donateWin.center();
  donateWin.show();
});

// ---------- lifecycle ----------

nativeTheme.themeSource = 'dark';
if (BENCH) {
  // Frames as fast as the renderer can make them, to see the real cost of drawing.
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
if (process.platform === 'win32') app.setAppUserModelId('io.github.artsocity23ux.artframes');

app.on('second-instance', () => win?.focus());
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (win) win.webContents.send('af:open-file', file);
  else pendingFile = file;
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  createWindow();
  log(`start ${app.getVersion()}`);
  if (SELFTEST) {
    require(BENCH ? './bench' : DEMO ? './demo' : './selftest')({ win, out: OUT }).catch(err => {
      console.error(err);
      app.exit(1);
    });
  }
});
