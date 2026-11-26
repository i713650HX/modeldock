const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseGGUF } = require('./gguf');
const logger = require('./logger');

let mainWindow;
const APP_VERSION = app.getVersion();

// ---- Crash / error logging (local only, never uploaded) ----
logger.pruneOldLogs();
logger.info('=== ModelDock ' + APP_VERSION + ' starting ===');

process.on('uncaughtException', (err) => {
  logger.crash('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logger.crash('unhandledRejection', reason);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 780,
    minHeight: 540,
    frame: true,
    backgroundColor: '#ffffff',
    title: 'ModelDock - 本地模型管理器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', async (e) => {
    if (activeDownloadCount <= 0) return;
    e.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['仍然退出', '留在这里'],
      defaultId: 1,
      cancelId: 1,
      title: '下载尚未完成',
      message: '还有 ' + activeDownloadCount + ' 个下载任务正在进行。',
      detail: '退出会中断下载。已下载的部分会保留，下次可断点续传。',
    });
    if (result.response === 0) {
      activeDownloadCount = 0;
      mainWindow.destroy();
    }
  });
}

// ---- Application menu ----
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '添加模型文件夹', accelerator: 'Ctrl+O', click: () => mainWindow.webContents.send('menu-add-folder') },
        { label: '下载模型', accelerator: 'Ctrl+D', click: () => mainWindow.webContents.send('menu-download') },
        { label: '刷新列表', accelerator: 'F5', click: () => mainWindow.webContents.send('menu-refresh') },
        { label: '导出清单 (CSV)', accelerator: 'Ctrl+S', click: () => mainWindow.webContents.send('menu-export') },
        { type: 'separator' },
        { label: '设置', accelerator: 'Ctrl+,', click: () => mainWindow.webContents.send('menu-settings') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '使用指南', accelerator: 'F1', click: () => mainWindow.webContents.send('menu-guide') },
        { label: '关于 ModelDock', click: () => mainWindow.webContents.send('menu-about') },
        { label: '开源致谢', click: () => mainWindow.webContents.send('menu-licenses') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Confirm before closing while downloads are active (partial files are kept for resume)
let activeDownloadCount = 0;
ipcMain.on('download-active-count', (event, count) => {
  activeDownloadCount = count;
});

// ---- Open folder picker ----
ipcMain.handle('pick-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择模型文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---- Recursive .gguf scan with metadata parsing ----
let scanDepth = 6; // configurable via settings

function walkDir(dir, fileList, depth) {
  if (depth > scanDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      walkDir(full, fileList, depth + 1);
    } else if (entry.isFile()) {
      if (entry.name.toLowerCase().endsWith('.gguf')) {
        try {
          const stat = fs.statSync(full);
          fileList.push({
            name: entry.name,
            path: full,
            size: stat.size,
            modified: stat.mtimeMs,
            dir: path.dirname(full),
          });
        } catch (err) {
          // skip unreadable files
        }
      }
    }
  }
}

// metadata cache: path -> { meta, mtime, size } — avoids re-parsing on every refresh
let metaCache = {};
const META_CACHE_FILE = path.join(app.getPath('userData'), 'meta-cache.json');

function loadMetaCache() {
  try {
    if (fs.existsSync(META_CACHE_FILE)) {
      metaCache = JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8')) || {};
    }
  } catch (err) {
    metaCache = {};
  }
}

let metaCacheTimer = null;
function saveMetaCacheSoon() {
  if (metaCacheTimer) clearTimeout(metaCacheTimer);
  metaCacheTimer = setTimeout(() => {
    try {
      fs.writeFileSync(META_CACHE_FILE, JSON.stringify(metaCache), 'utf8');
    } catch (err) {
      // ignore
    }
  }, 800);
}

loadMetaCache();

ipcMain.handle('scan-models', async (event, dirs) => {
  const all = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    walkDir(dir, all, 0);
  }
  // de-duplicate by path
  const seen = new Set();
  const models = all.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });

  // enrich with GGUF header metadata (cached by path + size + mtime)
  let cacheDirty = false;
  for (const m of models) {
    const key = m.path;
    const cached = metaCache[key];
    if (cached && cached.size === m.size && cached.modified === m.modified) {
      m.meta = cached.meta;
    } else {
      const meta = parseGGUF(m.path);
      m.meta = meta;
      metaCache[key] = { size: m.size, modified: m.modified, meta };
      cacheDirty = true;
    }
  }
  if (cacheDirty) saveMetaCacheSoon();

  return models;
});

// ---- Parse a single file on demand (for files added later) ----
ipcMain.handle('parse-gguf', async (event, filePath) => {
  return parseGGUF(filePath);
});

// ---- Actions ----
ipcMain.handle('copy-text', async (event, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('show-in-folder', async (event, filePath) => {
  if (!fs.existsSync(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('open-path', async (event, target) => {
  shell.openPath(target);
  return true;
});

// ---- Notes / tags store ----
const notesPath = path.join(app.getPath('userData'), 'notes.json');
let notes = {};
try {
  if (fs.existsSync(notesPath)) {
    notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')) || {};
  }
} catch (err) {
  notes = {};
}

ipcMain.handle('load-notes', async () => notes);

ipcMain.handle('save-note', async (event, filePath, payload) => {
  if (!filePath) return false;
  // payload is an object { tags: [], note: '' } — normalize legacy string form too.
  let entry = { tags: [], note: '' };
  if (typeof payload === 'string') {
    entry = { tags: [], note: payload };
  } else if (payload && typeof payload === 'object') {
    const tags = Array.isArray(payload.tags) ? payload.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
    const note = typeof payload.note === 'string' ? payload.note : '';
    entry = { tags: tags.map((t) => t.trim()), note: note.trim() };
  }
  const hasContent = entry.tags.length > 0 || entry.note.length > 0;
  if (hasContent) {
    notes[filePath] = entry;
  } else {
    delete notes[filePath];
  }
  try {
    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
});

// ---- Persist folders ----
const storePath = path.join(app.getPath('userData'), 'folders.json');

ipcMain.handle('load-folders', async () => {
  try {
    if (fs.existsSync(storePath)) {
      const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (err) {
    // ignore
  }
  // default candidate folders
  const home = app.getPath('home');
  const defaults = [
    path.join(home, '.lmstudio', 'models'),
    path.join(home, 'AppData', 'Local', 'lmstudio', 'models'),
  ].filter((p) => fs.existsSync(p));
  return defaults;
});

ipcMain.handle('save-folders', async (event, folders) => {
  try {
    fs.writeFileSync(storePath, JSON.stringify(folders, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
});

// ---- Export models to CSV ----
ipcMain.handle('export-csv', async (event, rows) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出模型清单',
      defaultPath: path.join(app.getPath('documents'), 'ModelDock-模型清单.csv'),
      filters: [
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    // UTF-8 BOM so Excel opens Chinese correctly
    const header = ['文件名', '大小(字节)', '格式化大小', '修改时间', '路径', '架构', '量化', '上下文长度', '参数量', '标签', '备注'];
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      lines.push([
        r.name, r.size, r.sizeText, r.dateText, r.path,
        r.architecture, r.quantization, r.contextLength, r.parameterCount,
        r.tags, r.note,
      ].map(esc).join(','));
    }
    fs.writeFileSync(result.filePath, '\ufeff' + lines.join('\r\n'), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ---- App info ----
ipcMain.handle('get-app-info', async () => ({
  version: APP_VERSION,
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
}));

ipcMain.handle('open-external', async (event, url) => {
  if (!/^https?:\/\//.test(url)) return false;
  shell.openExternal(url);
  return true;
});

// ---- Model downloader (Hugging Face) ----
const downloader = require('./downloader');
const { downloadFile, searchModels, getModelFiles, cancelDownload, pauseDownload, resumeDownload } = downloader;

ipcMain.handle('hf-search', async (event, query, source, typeFilter) => {
  try {
    const models = await searchModels(query, source, 30, typeFilter || '');
    return { ok: true, models };
  } catch (err) {
    logger.error('hf-search failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('hf-files', async (event, repoId, source) => {
  try {
    const files = await getModelFiles(repoId, source);
    return { ok: true, files };
  } catch (err) {
    logger.error('hf-files failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('download-start', async (event, task) => {
  // task: { id, repoId, file, destDir, sourceKey }
  try {
    const result = await downloadFile(task, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', progress);
      }
    });
    return result;
  } catch (err) {
    if (err.message === 'cancelled') return { ok: false, cancelled: true };
    logger.error('download failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('download-cancel', async (event, id) => cancelDownload(id));
ipcMain.handle('download-pause', async (event, id) => pauseDownload(id));
ipcMain.handle('download-resume', async (event, id) => resumeDownload(id));

ipcMain.handle('pick-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择下载目录',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---- Direct URL download (universal: any model, any source) ----
ipcMain.handle('download-url', async (event, task) => {
  // task: { id, url, fileName, destDir }
  try {
    const result = await downloadFile(task, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', progress);
      }
    });
    return result;
  } catch (err) {
    if (err.message === 'cancelled') return { ok: false, cancelled: true };
    logger.error('download failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// ---- GPU VRAM detection & model fit ----
const vram = require('./vram');
let gpuCache = null;

ipcMain.handle('get-gpus', async () => {
  if (!gpuCache) gpuCache = await vram.detectGPUs();
  return gpuCache;
});

ipcMain.handle('refresh-gpus', async () => {
  gpuCache = await vram.detectGPUs();
  return gpuCache;
});

ipcMain.handle('assess-fit', async (event, modelBytes) => {
  if (!gpuCache) gpuCache = await vram.detectGPUs();
  // pick the best GPU (NVIDIA first, biggest VRAM)
  const gpu = gpuCache && gpuCache[0];
  return vram.assessFit(modelBytes, gpu);
});

// ---- Supported GPU brands list (for UI legend) ----
ipcMain.handle('get-brands', async () => {
  const { BRANDS } = require('./brands');
  return BRANDS.map((b) => ({
    key: b.key, name: b.name, short: b.short, origin: b.origin,
  }));
});

// ---- Disk space check before download ----
ipcMain.handle('check-disk-space', async (event, dir, requiredBytes) => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    const free = st.bavail * st.bsize;
    return { ok: true, free, required: requiredBytes || 0, enough: !requiredBytes || free >= requiredBytes };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ---- SHA256 checksum of a local file (streamed, no memory blowup) ----
ipcMain.handle('file-sha256', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'file not found' };
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return { ok: true, sha256: hash.digest('hex') };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ---- Scan depth setting ----
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let appSettings = {};
try {
  if (fs.existsSync(settingsPath)) appSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
} catch (e) { appSettings = {}; }
if (appSettings.scanDepth && appSettings.scanDepth >= 1 && appSettings.scanDepth <= 20) {
  scanDepth = appSettings.scanDepth;
}

ipcMain.handle('load-settings', async () => ({ scanDepth }));

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    if (settings && settings.scanDepth >= 1 && settings.scanDepth <= 20) {
      scanDepth = settings.scanDepth;
      appSettings.scanDepth = scanDepth;
      fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
});

// ---- Third-party license notices ----
ipcMain.handle('get-licenses', async () => {
  const candidates = [
    path.join(__dirname, 'THIRD_PARTY_NOTICES.md'),
    path.join(process.resourcesPath || '', 'THIRD_PARTY_NOTICES.md'),
    path.join(app.getAppPath(), 'THIRD_PARTY_NOTICES.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return { ok: true, text: fs.readFileSync(p, 'utf8'), path: p };
      }
    } catch (e) { /* try next */ }
  }
  return { ok: false, error: 'license file not found' };
});

ipcMain.handle('open-license-file', async (event, name) => {
  // open bundled license files in default app (Notepad / browser)
  const candidates = [
    path.join(process.resourcesPath || '', name),
    path.join(path.dirname(process.execPath), name),
    path.join(__dirname, name),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        shell.openPath(p);
        return true;
      }
    } catch (e) { /* try next */ }
  }
  return false;
});

// ---- Renderer log forwarding (local file only) ----
ipcMain.on('renderer-log', (event, level, message) => {
  const fn = level === 'error' || level === 'crash' ? logger.error : logger.info;
  fn('[renderer] ' + String(message));
});

ipcMain.handle('get-log-dir', async () => logger.getLogDir());

// ---- User guide ----
ipcMain.handle('get-guide', async () => {
  const candidates = [
    path.join(__dirname, 'GUIDE.md'),
    path.join(process.resourcesPath || '', 'GUIDE.md'),
    path.join(app.getAppPath(), 'GUIDE.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { ok: true, text: fs.readFileSync(p, 'utf8') };
    } catch (e) { /* try next */ }
  }
  return { ok: false, error: 'guide file not found' };
});
