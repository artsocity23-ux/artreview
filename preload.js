const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// Everything returns a Promise except env, pathForFile and the fire-and-forget calls (dragOut, setTitle, log, ...).
contextBridge.exposeInMainWorld('ar', {
  env: ipcRenderer.sendSync('ar:env'),
  // dialogs and files
  openDialog: kind => invoke('ar:open-dialog', kind), // 'video' | 'review' -> path | null
  saveDialog: (kind, name) => invoke('ar:save-dialog', kind, name), // 'review' -> path | null
  folderDialog: () => invoke('ar:folder-dialog'),
  read: file => invoke('ar:read', file), // -> Uint8Array
  write: (file, bytes) => invoke('ar:write', file, bytes), // bytes or a string; creates the folder
  stat: file => invoke('ar:stat', file), // -> { size, mtime } | null
  fileURL: file => invoke('ar:file-url', file),
  reveal: file => invoke('ar:reveal', file),
  pathForFile: file => webUtils.getPathForFile(file),
  range: (file, start, end) => invoke('ar:range', file, start, end),
  rangeClose: file => invoke('ar:range-close', file),
  // settings and autosave
  settings: () => invoke('ar:settings'),
  setSettings: patch => invoke('ar:set-settings', patch), // -> the full settings after the patch
  defaultOutDir: () => invoke('ar:default-out-dir'),
  reviewAutosave: (key, json) => invoke('ar:review-autosave', key, json), // key /^[0-9a-f]{8,64}$/, json = JSON text
  reviewAutoload: key => invoke('ar:review-autoload', key), // -> the saved JSON text | null
  // clipboard and sharing
  copyVideo: (file, text) => invoke('ar:copy-video', file, text ?? null), // -> { ok, withText }
  copyText: text => invoke('ar:copy-text', text),
  dragOut: file => ipcRenderer.send('ar:drag-out', file), // call from a dragstart handler (after preventDefault)
  // files from the OS
  pendingFile: () => invoke('ar:pending-file'),
  onOpenFile: cb => ipcRenderer.on('ar:open-file', (e, file) => cb(file)),
  // window
  setTitle: title => ipcRenderer.send('ar:set-title', title),
  log: (...parts) => ipcRenderer.send('ar:log', ...parts),
  // donate
  donateAvailable: () => invoke('ar:donate-available'),
  openDonate: () => ipcRenderer.send('ar:donate-open-window'),
  donate: () => invoke('ar:donate'),
  donateCopy: i => invoke('ar:donate-copy', i),
  donateOpen: i => ipcRenderer.send('ar:donate-open', i),
  donateReady: height => ipcRenderer.send('ar:donate-ready', height),
});
