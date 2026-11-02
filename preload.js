const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('af', {
  env: ipcRenderer.sendSync('af:env'),
  // dialogs and files
  openDialog: kind => invoke('af:open-dialog', kind),
  saveDialog: (kind, name) => invoke('af:save-dialog', kind, name),
  folderDialog: () => invoke('af:folder-dialog'),
  read: file => invoke('af:read', file),
  write: (file, data) => invoke('af:write', file, data),
  writeIn: (dir, name, data) => invoke('af:write-in', dir, name, data),
  stat: file => invoke('af:stat', file),
  fileURL: file => invoke('af:file-url', file),
  reveal: file => invoke('af:reveal', file),
  pathForFile: file => webUtils.getPathForFile(file),
  range: (file, start, end) => invoke('af:range', file, start, end),
  rangeClose: file => invoke('af:range-close', file),
  // projects
  saveProject: (file, payload) => invoke('af:project-save', file, payload),
  loadProject: file => invoke('af:project-load', file),
  autosave: payload => invoke('af:autosave', payload),
  autosaveInfo: () => invoke('af:autosave-info'),
  autosaveLoad: () => invoke('af:autosave-load'),
  autosaveClear: () => invoke('af:autosave-clear'),
  pendingFile: () => invoke('af:pending-file'),
  onOpenFile: cb => ipcRenderer.on('af:open-file', (e, file) => cb(file)),
  onSaveAndClose: cb => ipcRenderer.on('af:save-and-close', () => cb()),
  // window
  setState: state => ipcRenderer.send('af:state', state),
  closeNow: () => ipcRenderer.send('af:close-now'),
  log: (...parts) => ipcRenderer.send('af:log', ...parts),
  // donate
  donateAvailable: () => invoke('af:donate-available'),
  openDonate: () => ipcRenderer.send('af:donate-open-window'),
  donate: () => invoke('af:donate'),
  donateCopy: i => invoke('af:donate-copy', i),
  donateOpen: i => ipcRenderer.send('af:donate-open', i),
  donateReady: height => ipcRenderer.send('af:donate-ready', height),
});
