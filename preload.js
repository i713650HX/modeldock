const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  scanModels: (dirs) => ipcRenderer.invoke('scan-models', dirs),
  parseGGUF: (p) => ipcRenderer.invoke('parse-gguf', p),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  loadFolders: () => ipcRenderer.invoke('load-folders'),
  saveFolders: (folders) => ipcRenderer.invoke('save-folders', folders),
  loadNotes: () => ipcRenderer.invoke('load-notes'),
  saveNote: (filePath, note) => ipcRenderer.invoke('save-note', filePath, note),
  exportCsv: (rows) => ipcRenderer.invoke('export-csv', rows),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getGpus: () => ipcRenderer.invoke('get-gpus'),
  refreshGpus: () => ipcRenderer.invoke('refresh-gpus'),
  assessFit: (bytes) => ipcRenderer.invoke('assess-fit', bytes),
  getBrands: () => ipcRenderer.invoke('get-brands'),
  checkDiskSpace: (dir, bytes) => ipcRenderer.invoke('check-disk-space', dir, bytes),
  fileSha256: (filePath) => ipcRenderer.invoke('file-sha256', filePath),
  reportActiveDownloads: (count) => ipcRenderer.send('download-active-count', count),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  openLicenseFile: (name) => ipcRenderer.invoke('open-license-file', name),
  log: (level, message) => ipcRenderer.send('renderer-log', level, message),
  getLogDir: () => ipcRenderer.invoke('get-log-dir'),
  getGuide: () => ipcRenderer.invoke('get-guide'),
  setSecret: (key, value) => ipcRenderer.invoke('set-secret', key, value),
  getSecret: (key) => ipcRenderer.invoke('get-secret', key),
  hasSecret: (key) => ipcRenderer.invoke('has-secret', key),

  // model downloader
  hfSearch: (q, source, typeFilter) => ipcRenderer.invoke('hf-search', q, source, typeFilter),
  hfFiles: (repo, source) => ipcRenderer.invoke('hf-files', repo, source),
  downloadStart: (task) => ipcRenderer.invoke('download-start', task),
  downloadUrl: (task) => ipcRenderer.invoke('download-url', task),
  downloadCancel: (id) => ipcRenderer.invoke('download-cancel', id),
  downloadPause: (id) => ipcRenderer.invoke('download-pause', id),
  downloadResume: (id) => ipcRenderer.invoke('download-resume', id),
  pickDownloadDir: () => ipcRenderer.invoke('pick-download-dir'),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (e, data) => callback(data)),

  // menu events from main process
  onMenu: (callback) => {
    const events = ['menu-add-folder', 'menu-download', 'menu-refresh', 'menu-export', 'menu-settings', 'menu-about', 'menu-licenses', 'menu-guide'];
    events.forEach((evt) => ipcRenderer.on(evt, () => callback(evt)));
  },
});
