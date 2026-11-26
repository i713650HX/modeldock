const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseGGUF } = require('./gguf');
const logger = require('./logger');

let mainWindow;
const APP_VERSION = app.getVersion();

// ---- Crash / error logging (local only, never uploaded) ----
logger.pruneOldLogs();
logger.info('=== ModelLodge ' + APP_VERSION + ' starting ===');

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
    title: 'ModelLodge - 本地模型管理器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Minimize to tray while downloads are active; otherwise quit normally.
  mainWindow.on('close', (e) => {
    if (trayQuitting) return; // explicit quit from tray menu
    if (activeDownloadCount > 0) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) tray.setToolTip('ModelLodge - ' + activeDownloadCount + ' 个下载进行中（双击恢复）');
      if (!trayNotified) {
        trayNotified = true;
        logger.info('minimized to tray with ' + activeDownloadCount + ' active downloads');
      }
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
        { label: '关于 ModelLodge', click: () => mainWindow.webContents.send('menu-about') },
        { label: '开源致谢', click: () => mainWindow.webContents.send('menu-licenses') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- System tray ----
let tray = null;
let trayQuitting = false;
let trayNotified = false;

function createTray() {
  try {
    // Reuse the app icon for the tray (16px variant if available)
    const iconPath = path.join(__dirname, 'icon-16.png');
    let icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(icon);
    tray.setToolTip('ModelLodge - 本地模型管理器');
    const ctx = Menu.buildFromTemplate([
      { label: '打开 ModelLodge', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: '下载任务', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('menu-download'); } } },
      { type: 'separator' },
      { label: '退出', click: () => { trayQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(ctx);
    tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch (e) {
    logger.error('createTray failed', e);
  }
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  createTray();

  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray when downloads are active or tray exists (Windows).
  if (process.platform === 'darwin') return;
  if (tray && activeDownloadCount > 0) return; // stay alive for downloads
  if (trayQuitting) app.quit();
});

// Confirm before closing while downloads are active (partial files are kept for resume)
let activeDownloadCount = 0;
ipcMain.on('download-active-count', (event, count) => {
  activeDownloadCount = count;
  if (tray) {
    tray.setToolTip(count > 0
      ? 'ModelLodge - ' + count + ' 个下载进行中（双击恢复）'
      : 'ModelLodge - 本地模型管理器');
  }
  if (count === 0) trayNotified = false;
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

// ---- Recursive model-file scan with metadata parsing ----
let scanDepth = 6; // configurable via settings

// All model file formats we recognize (15+) for the local asset library.
const MODEL_EXTS = new Set([
  '.gguf', '.safetensors', '.bin', '.pt', '.pth', '.onnx', '.ckpt', '.h5',
  '.pb', '.tflite', '.npz', '.model', '.cbm', '.ggml', '.mlmodel',
]);
const MODEL_TYPE_LABEL = {
  gguf: 'GGUF', safetensors: 'SafeTensors', bin: 'BIN', pt: 'PyTorch', pth: 'PyTorch',
  onnx: 'ONNX', ckpt: 'Checkpoint', h5: 'Keras', pb: 'TensorFlow', tflite: 'TFLite',
  npz: 'NumPy', model: 'Model', cbm: 'CatBoost', ggml: 'GGML', mlmodel: 'CoreML',
};

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
      const ext = path.extname(entry.name).toLowerCase();
      if (MODEL_EXTS.has(ext)) {
        try {
          const stat = fs.statSync(full);
          // Infer publisher/repo from a .../{publisher}/{repo}/file.gguf layout
          const parts = path.dirname(full).split(path.sep).filter(Boolean);
          const origin = parts.length >= 2 ? parts.slice(-2).join('/') : '';
          fileList.push({
            name: entry.name,
            path: full,
            size: stat.size,
            modified: stat.mtimeMs,
            dir: path.dirname(full),
            ext: ext.slice(1),
            type: MODEL_TYPE_LABEL[ext.slice(1)] || ext.slice(1).toUpperCase(),
            origin,
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
    const isGGUF = (m.ext || path.extname(m.path).slice(1).toLowerCase()) === 'gguf';
    if (cached && cached.size === m.size && cached.modified === m.modified) {
      m.meta = cached.meta;
    } else if (isGGUF) {
      const meta = parseGGUF(m.path);
      m.meta = meta;
      metaCache[key] = { size: m.size, modified: m.modified, meta };
      cacheDirty = true;
    } else {
      // Non-GGUF formats: no header metadata, show file type instead
      m.meta = { ok: false, format: m.type, noHeader: true };
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
      defaultPath: path.join(app.getPath('documents'), 'ModelLodge-模型清单.csv'),
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
const { downloadFile, searchModels, getModelFiles, cancelDownload, pauseDownload, resumeDownload, setHfToken, setProxy, testMirrorSpeed } = downloader;

ipcMain.handle('hf-search', async (event, query, source, typeFilter) => {
  try {
    const models = await searchModels(query, source, 30, typeFilter || '');
    return { ok: true, models };
  } catch (err) {
    logger.error('hf-search failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('hf-files', async (event, repoId, source, revision) => {
  try {
    const files = await getModelFiles(repoId, source, revision);
    return { ok: true, files };
  } catch (err) {
    logger.error('hf-files failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('download-start', async (event, task) => {
  // task: { id, repoId, file, destDir, sourceKey }
  if (!task.conflict) task.conflict = appSettings.conflict || 'skip';
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
  if (!task.conflict) task.conflict = appSettings.conflict || 'skip';
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

ipcMain.handle('load-settings', async () => ({ scanDepth, proxy: appSettings.proxy || '', conflict: appSettings.conflict || 'skip', concurrent: appSettings.concurrent || 2 }));

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    if (!settings) return false;
    if (settings.scanDepth >= 1 && settings.scanDepth <= 20) {
      scanDepth = settings.scanDepth;
      appSettings.scanDepth = scanDepth;
    }
    if (typeof settings.proxy === 'string') {
      appSettings.proxy = settings.proxy.trim();
      setProxy(appSettings.proxy);
    }
    if (['skip', 'overwrite', 'rename'].includes(settings.conflict)) {
      appSettings.conflict = settings.conflict;
    }
    if (settings.concurrent >= 1 && settings.concurrent <= 8) {
      appSettings.concurrent = settings.concurrent;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
    return true;
  } catch (e) {
    logger.error('save-settings failed', e);
    return false;
  }
});

// mirror speed test
ipcMain.handle('test-mirror-speed', async (event, sourceKey) => {
  try { return await testMirrorSpeed(sourceKey); }
  catch (e) { return { source: sourceKey, ms: -1, ok: false }; }
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

// ---- Encrypted credential storage (Electron safeStorage = Windows DPAPI) ----
const { safeStorage } = require('electron');
const secretsPath = path.join(app.getPath('userData'), 'secrets.json');
let secrets = {};
try {
  if (fs.existsSync(secretsPath)) secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) || {};
} catch (e) { secrets = {}; }

ipcMain.handle('set-secret', async (event, key, value) => {
  try {
    if (value && value.trim()) {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = safeStorage.encryptString(value.trim());
        secrets[key] = buf.toString('base64');
      } else {
        // fallback: plain (rare on Windows); still local-only
        secrets[key] = value.trim();
      }
    } else {
      delete secrets[key];
    }
    fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf8');
    syncHfToken();
    return true;
  } catch (err) {
    logger.error('set-secret failed', err);
    return false;
  }
});

ipcMain.handle('get-secret', async (event, key) => {
  try {
    const v = secrets[key];
    if (!v) return '';
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(v, 'base64'));
    }
    return v;
  } catch (err) {
    return '';
  }
});

ipcMain.handle('has-secret', async (event, key) => !!secrets[key]);

// Sync HF token into the downloader on startup and whenever it changes.
function syncHfToken() {
  try {
    const v = secrets['hfToken'];
    if (!v) { setHfToken(''); return; }
    const token = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(v, 'base64')) : v;
    setHfToken(token);
  } catch (e) { setHfToken(''); }
}
syncHfToken();
// Apply saved proxy on startup
try { setProxy(appSettings.proxy || ''); } catch (e) { /* ignore */ }

// ---- Download task persistence (survive restart) ----
const downloadsPath = path.join(app.getPath('userData'), 'downloads.json');
ipcMain.handle('save-downloads', async (event, tasks) => {
  try {
    // Only keep non-terminal tasks; strip runtime-only fields.
    const keep = (tasks || []).filter(t => ['pending', 'downloading', 'paused', 'error', 'stalled'].includes(t.status))
      .map(t => ({
        id: t.id, name: t.name, status: t.status === 'downloading' ? 'paused' : t.status,
        loaded: t.loaded || 0, total: t.total || 0, task: t.task, error: t.error || '',
        savedAt: Date.now(),
      }));
    fs.writeFileSync(downloadsPath, JSON.stringify(keep, null, 2), 'utf8');
    return true;
  } catch (e) { logger.error('save-downloads failed', e); return false; }
});

ipcMain.handle('load-downloads', async () => {
  try {
    if (!fs.existsSync(downloadsPath)) return [];
    const arr = JSON.parse(fs.readFileSync(downloadsPath, 'utf8')) || [];
    // Drop tasks older than 30 days (stale records)
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    return arr.filter(t => !t.savedAt || t.savedAt > cutoff);
  } catch (e) { return []; }
});

// ---- Safetensors shard integrity precheck ----
// Given a model file path, look for a sibling *.index.json and verify all shards exist.
ipcMain.handle('check-shards', async (event, filePath) => {
  try {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    // find shard pattern: model-00001-of-00004.safetensors
    const m = name.match(/^(.*?)(\d+)-of-(\d+)\.safetensors$/i);
    if (!m) return { applicable: false };
    const total = parseInt(m[3], 10);
    const prefix = m[1];
    const files = fs.readdirSync(dir);
    const shards = files.filter(f => f.startsWith(prefix) && /\.safetensors$/i.test(f));
    const missing = [];
    for (let i = 1; i <= total; i++) {
      const expected = prefix + String(i).padStart(5, '0') + '-of-' + String(total).padStart(5, '0') + '.safetensors';
      if (!files.includes(expected)) missing.push(expected);
    }
    // look for index json
    const indexFiles = files.filter(f => f.endsWith('.index.json') || f === 'model.safetensors.index.json');
    return {
      applicable: true,
      total,
      found: shards.length,
      missing,
      hasIndex: indexFiles.length > 0,
      ok: missing.length === 0,
    };
  } catch (e) {
    return { applicable: false, error: e.message };
  }
});
