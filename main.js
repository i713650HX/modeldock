const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseGGUF } = require('./gguf');
const logger = require('./logger');
const apiServer = require('./api-server');
const modelCheck = require('./model-check');

let mainWindow;
const APP_VERSION = app.getVersion();
// Public download URL for the optional CUDA component pack. Change this one
// line if the zip is mirrored to another host (e.g. a China-friendly CDN).
const CUDA_PACK_URL = 'https://github.com/i713650HX/modellodge/releases/download/v2.5.0/ModelLodge-CUDA12-Component.zip';
function emitFileProgress(data) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('file-progress', data); } catch (_) {}
  }
}

// ---- Footprint optimizations (applied before app is ready) ----
// This app is a flat list UI: no 3D/canvas, so Chromium's GPU process is pure overhead.
// Software rendering is plenty fast here and removes one whole child process (~40-50 MB).
if (process.env.MODELLODGE_GPU !== '1') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}
// Trim Chromium background services we never use.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('disable-features', 'Translate,BackForwardCache,MediaRouter,DialMediaRouteProvider,AcceptCHFrame');
// Keep background downloads alive without full renderer throttling.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ---- Crash / error logging (local only, never uploaded) ----
logger.pruneOldLogs();
logger.info('=== ModelLodge ' + APP_VERSION + ' starting ===');
app.on('before-quit', () => {
  // Stop the optional API server and kill the bundled llama-server so neither
  // lingers holding a port or GPU memory.
  try { apiServer.stopServer(); } catch (_) {}
  try { require('./engine').stopEngine(); } catch (_) {}
  try { logger.flush(); } catch (_) {}
});

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

const SCREENSHOT_MODE = process.env.MODELLODGE_SCREENSHOT === '1';
app.whenReady().then(() => {
  if (!SCREENSHOT_MODE) {
    createWindow();
    buildMenu();
    createTray();
  }
  // Restore the OpenAI-compatible API server if the user left it enabled.
  try {
    apiServer.restore({
      enabled: !!(appSettings.apiServer && appSettings.apiServer.enabled),
      lan: !!(appSettings.apiServer && appSettings.apiServer.lan),
      port: (appSettings.apiServer && appSettings.apiServer.port) || 1234,
      token: appSettings.apiServer && appSettings.apiServer.token,
    });
    // Persist a freshly generated token on first enable.
    apiServer.status();
  } catch (e) { logger.error('api-server restore failed', e); }

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

// ---- Pick individual GGUF files anywhere on disk (for chat) ----
// Remember the last directory: opening at "此电脑" makes Windows enumerate
// every drive (network drives, WSL, removable media), which can hang the dialog.
const lastModelDirPath = path.join(app.getPath('userData'), 'last-model-dir.json');
let lastModelDir = '';
try {
  if (fs.existsSync(lastModelDirPath)) {
    const saved = JSON.parse(fs.readFileSync(lastModelDirPath, 'utf8'));
    if (saved && typeof saved.dir === 'string' && fs.existsSync(saved.dir)) lastModelDir = saved.dir;
  }
} catch (e) { /* ignore */ }

function resolveStartDir() {
  if (lastModelDir && fs.existsSync(lastModelDir)) return lastModelDir;
  const home = app.getPath('home');
  const candidates = [path.join(home, '.lmstudio', 'models'), path.join(home, 'Downloads'), home];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return home;
}

ipcMain.handle('pick-model-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '选择 GGUF 模型文件',
    defaultPath: resolveStartDir(),
    filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths.length) return [];
  try {
    const dir = path.dirname(result.filePaths[0]);
    if (dir && dir !== lastModelDir) {
      lastModelDir = dir;
      fs.writeFileSync(lastModelDirPath, JSON.stringify({ dir }), 'utf8');
    }
  } catch (e) { /* ignore */ }
  // Async stat in parallel: statSync on a slow/network drive blocks the main
  // process and is a common cause of the whole app freezing after a pick.
  const files = await Promise.all(result.filePaths.map(async (p) => {
    let size = 0;
    try { size = (await fs.promises.stat(p)).size; } catch (e) { /* ignore */ }
    return { path: p, name: path.basename(p), size };
  }));
  return files;
});

// ---- Recursive model-file scan with metadata parsing ----
let scanDepth = 6; // configurable via settings
// Directories that never contain model files. Users can extend the list in
// Settings; the defaults stop scans from walking system/cache trees.
const DEFAULT_SCAN_EXCLUDES = [
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  'AppData', '$Recycle.Bin', 'System Volume Information', 'Recovery',
  'node_modules', '__pycache__', '.git', 'venv', '.venv', 'site-packages',
  'dist', 'build', 'Cache', 'Code Cache', 'GPUCache', 'Temp',
];
let scanExcludes = DEFAULT_SCAN_EXCLUDES.slice();
function excludedDirName(name) {
  const n = name.toLowerCase();
  return scanExcludes.some((x) => n === x.toLowerCase());
}

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
      if (excludedDirName(entry.name)) continue;
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

// ---- Persist chat's explicitly-imported GGUF files ----
// Without this, importing a model from an arbitrary path only lives in memory
// and is lost on restart — which defeats the whole "import from anywhere" flow.
const importedModelsPath = path.join(app.getPath('userData'), 'imported-models.json');

ipcMain.handle('load-imported-models', async () => {
  try {
    if (fs.existsSync(importedModelsPath)) {
      const data = JSON.parse(fs.readFileSync(importedModelsPath, 'utf8'));
      if (Array.isArray(data)) {
        // Drop entries whose file no longer exists, so the dropdown stays honest.
        return data.filter((m) => m && m.path && fs.existsSync(m.path));
      }
    }
  } catch (err) { /* ignore */ }
  return [];
});

ipcMain.handle('save-imported-models', async (event, models) => {
  try {
    if (!Array.isArray(models)) return false;
    fs.writeFileSync(importedModelsPath, JSON.stringify(models, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
});

// ---- Work assistant: document context, chat sessions, Markdown export ----
// Everything stays on disk under userData. Nothing is uploaded anywhere.
const chatSessionsPath = path.join(app.getPath('userData'), 'chat-sessions.json');

// Document parsing lives in document.js so PDF / Word / Excel / PowerPoint /
// text files all go through one local pipeline. Nothing is uploaded.
const { parseDocument, TEXT_EXTS: DOC_TEXT_EXTS } = require('./document');
const CONTEXT_TEXT_EXTS = Array.from(DOC_TEXT_EXTS).concat(['pdf', 'docx', 'xlsx', 'xls', 'pptx']);
const MAX_CONTEXT_CHARS = 32000;

ipcMain.handle('pick-context-files', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择要加入对话的文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档 / 表格 / 代码', extensions: CONTEXT_TEXT_EXTS },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    return {
      ok: true,
      files: filePaths.map((p) => ({ name: path.basename(p), path: p })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Every file is parsed independently: one bad file never blocks the batch.
// Reading is confirmed up front — the work assistant can call this with paths
// the model picked, so it must meet the same bar as read_file (default Cancel).
ipcMain.handle('read-context-files', async (event, filePaths) => {
  const paths = filePaths || [];
  if (!paths.length) return { ok: true, files: [] };
  const names = paths.slice(0, 8).map((p) => '· ' + path.basename(String(p)));
  if (paths.length > 8) names.push('…（共 ' + paths.length + ' 个文件）');
  const confirm = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['确认读取', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: 'ModelLodge · 读取文件确认',
    message: '将读取 ' + paths.length + ' 个文件加入对话上下文',
    detail: names.join('\n') + '\n\n内容只在本机解析；若开启联网搜索，请勿把文件内容写进搜索词。',
  });
  if (confirm.response !== 0) return { ok: false, canceled: true };
  const files = [];
  let budget = MAX_CONTEXT_CHARS;
  for (const p of paths) {
    const parsed = await parseDocument(p);
    if (!parsed.ok) {
      files.push({ name: path.basename(p), path: p, content: '', error: parsed.error });
      continue;
    }
    let content = parsed.text || '';
    let truncated = !!parsed.truncated;
    if (content.length > budget) {
      content = content.slice(0, budget);
      truncated = true;
    }
    budget -= content.length;
    files.push({ name: parsed.name, path: p, content, truncated, type: parsed.type });
    if (budget <= 0) break;
  }
  return { ok: true, files };
});

ipcMain.handle('load-chat-sessions', async () => {
  try {
    if (fs.existsSync(chatSessionsPath)) {
      const data = JSON.parse(fs.readFileSync(chatSessionsPath, 'utf8'));
      if (data && Array.isArray(data.sessions)) {
        return { ok: true, sessions: data.sessions, activeId: data.activeId || null };
      }
    }
  } catch (err) { /* corrupt file: start fresh */ }
  return { ok: true, sessions: [], activeId: null };
});

ipcMain.handle('save-chat-sessions', async (event, payload) => {
  try {
    if (!payload || !Array.isArray(payload.sessions)) return false;
    const data = {
      activeId: payload.activeId || null,
      sessions: payload.sessions.slice(0, 100),
    };
    fs.writeFileSync(chatSessionsPath, JSON.stringify(data), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
});

ipcMain.handle('export-chat-md', async (event, content, suggestedName) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出对话记录',
      defaultPath: suggestedName || 'ModelLodge-对话.md',
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, content || '', 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Curated software catalogue + controlled computer actions ----
const { executeAction } = require('./actions');
const { listSoftware } = require('./software-catalog');

ipcMain.handle('software-list', async (event, query) => ({ ok: true, items: listSoftware(query) }));

ipcMain.handle('assistant-action', async (event, key, param, opts) => {
  try {
    // All actions — including download_software — go through executeAction,
    // which enforces native confirmation for writes, scripts and downloads.
    // Never special-case a download here: that would bypass the confirmation.
    const wrapped = {
      ...(opts || {}),
      onProgress: (progress) => {
        try { if (!event.sender.isDestroyed()) event.sender.send('download-progress', progress); } catch (_) {}
      },
      onDone: (data) => {
        try { if (!event.sender.isDestroyed()) event.sender.send('software-download-done', data); } catch (_) {}
      },
    };
    return await executeAction(key, param, mainWindow, wrapped);
  } catch (err) {
    return { ok: false, error: err.message };
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
const chat = require('./chat');
const engine = require('./engine');
const websearch = require('./websearch');
const { downloadFile, searchModels, getModelFiles, getModelDetail, getReadme, buildDownloadOptions, cancelDownload, pauseDownload, resumeDownload, setHfToken, setDownloadThreads, setProxy: setDownloaderProxy, testMirrorSpeed } = downloader;
// Apply proxy to both the downloader and web search in one place.
function setProxy(url) {
  setDownloaderProxy(url);
  try { websearch.setProxy(url); } catch (e) { /* ignore */ }
}

ipcMain.handle('hf-search', async (event, query, source, typeFilter) => {
  try {
    const models = await searchModels(query, source, 40, typeFilter || '');
    // Gated repos are never silently swapped for same-named ModelScope repos:
    // those are often unrelated community uploads. Surface the requirement.
    const gatedHint = source !== 'ms' && /(llama|gemma|mistral|nous-hermes)/i.test(query || '')
      ? '若目标是 Hugging Face 上的受限（gated）模型，需要在设置里保存 HF Token 并先在网页接受许可；软件不会自动改用魔搭同名仓库。'
      : '';
    return { ok: true, models, gatedHint };
  } catch (err) {
    logger.error('hf-search failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// Model detail page: description, params, license, README.
ipcMain.handle('model-detail', async (event, repoId, source, revision) => {
  try {
    const detail = await getModelDetail(repoId, source, revision);
    return { ok: true, detail };
  } catch (err) {
    logger.error('model-detail failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('model-readme', async (event, repoId, source, revision) => {
  try {
    const text = await getReadme(repoId, source, revision);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Download options for a repo: one entry per quantization (shards merged).
ipcMain.handle('model-options', async (event, repoId, source, revision) => {
  try {
    const files = await getModelFiles(repoId, source, revision);
    const { options, otherFiles } = buildDownloadOptions(files);
    return { ok: true, options, otherFiles, files };
  } catch (err) {
    logger.error('model-options failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// One round trip for the model page: metadata + download options.
// README is deliberately NOT included here — the raw README endpoint is slow
// on CN mirrors and would block the quantization list the user actually wants.
ipcMain.handle('model-page', async (event, repoId, source, revision) => {
  const out = { ok: true, detail: null, options: [], otherFiles: [] };
  const jobs = [
    getModelDetail(repoId, source, revision).then((d) => { out.detail = d; }).catch((e) => { out.detailError = e.message; }),
    getModelFiles(repoId, source, revision)
      .then((files) => {
        const r = buildDownloadOptions(files);
        out.options = r.options;
        out.otherFiles = r.otherFiles;
      })
      .catch((e) => { out.optionsError = e.message; }),
  ];
  await Promise.all(jobs);
  return out;
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
  // task: { id, repoId, file/files, destDir, sourceKey }
  if (!task.conflict) task.conflict = appSettings.conflict || 'skip';
  try {
    const result = await downloadFile(task, (progress) => {
      // Send to the window that started the download (not necessarily the main one).
      const target = event.sender;
      if (target && !target.isDestroyed()) {
        target.send('download-progress', progress);
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
      const target = event.sender;
      if (target && !target.isDestroyed()) {
        target.send('download-progress', progress);
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
    const total = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);
    const started = Date.now();
    let done = 0;
    let lastSent = 0;
    for await (const chunk of stream) {
      hash.update(chunk);
      done += chunk.length;
      // Throttle events to ~100ms; big GGUFs can be tens of GB.
      if (Date.now() - lastSent > 100 && mainWindow) {
        lastSent = Date.now();
        const pct = total ? done / total : 0;
        const eta = pct > 0 ? Math.round((Date.now() - started) * (1 - pct) / pct / 1000) : -1;
        emitFileProgress({ kind: 'sha256', name: path.basename(filePath), pct, done, total, eta });
      }
    }
    emitFileProgress({ kind: 'sha256', name: path.basename(filePath), pct: 1, done: total, total, eta: 0 });
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
if (typeof appSettings.scanExcludes === 'string' && appSettings.scanExcludes.trim()) {
  scanExcludes = DEFAULT_SCAN_EXCLUDES.concat(
    appSettings.scanExcludes.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
  );
}
// Apply the persisted segmented-download thread count at startup.
setDownloadThreads(appSettings.downloadThreads || 8);

ipcMain.handle('load-settings', async () => ({
  scanDepth,
  scanExcludes: scanExcludes.join(', '),
  backendPreference: appSettings.backendPreference || 'auto',
  proxy: appSettings.proxy || '', conflict: appSettings.conflict || 'skip',
  concurrent: appSettings.concurrent || 2, theme: appSettings.theme || 'light',
  downloadThreads: appSettings.downloadThreads || 8,
  lang: appSettings.lang || 'zh',
  cols: appSettings.cols || null,
  apiServer: {
    enabled: !!(appSettings.apiServer && appSettings.apiServer.enabled),
    lan: !!(appSettings.apiServer && appSettings.apiServer.lan),
    port: (appSettings.apiServer && appSettings.apiServer.port) || 1234,
  },
}));

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    if (!settings) return false;
    if (settings.scanDepth >= 1 && settings.scanDepth <= 20) {
      scanDepth = settings.scanDepth;
      appSettings.scanDepth = scanDepth;
    }
    if (typeof settings.scanExcludes === 'string') {
      const extra = settings.scanExcludes.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      scanExcludes = DEFAULT_SCAN_EXCLUDES.concat(extra);
      appSettings.scanExcludes = settings.scanExcludes;
    }
    if (['auto', 'cuda', 'vulkan', 'cpu'].includes(settings.backendPreference)) {
      appSettings.backendPreference = settings.backendPreference;
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
    if (settings.downloadThreads >= 1 && settings.downloadThreads <= 16) {
      appSettings.downloadThreads = Math.floor(settings.downloadThreads);
      setDownloadThreads(appSettings.downloadThreads);
    }
    if (['light', 'dark', 'system'].includes(settings.theme)) {
      appSettings.theme = settings.theme;
    }
    if (['zh', 'en', 'ja'].includes(settings.lang)) appSettings.lang = settings.lang;
    if (settings.cols && typeof settings.cols === 'object') appSettings.cols = settings.cols;
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

// ---- Drag & drop model files/folders into the app ----
// Resolve dropped paths to their containing folders; renderer merges with its folder list.
ipcMain.handle('import-dropped-paths', async (event, paths, currentFolders) => {
  try {
    const folders = Array.isArray(currentFolders) ? [...currentFolders] : [];
    const addedDirs = [];
    for (const p of (paths || [])) {
      try {
        const st = fs.statSync(p);
        const dir = st.isDirectory() ? p : path.dirname(p);
        if (!folders.includes(dir)) { folders.push(dir); addedDirs.push(dir); }
      } catch (e) { /* skip invalid paths */ }
    }
    if (addedDirs.length) fs.writeFileSync(storePath, JSON.stringify(folders, null, 2), 'utf8');
    return { ok: true, added: addedDirs.length, folders };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Desktop notification on download completion ----
ipcMain.on('notify-download-done', (event, name) => {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'ModelLodge - 下载完成', body: name, icon: path.join(__dirname, 'icon.png') });
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  } catch (e) { /* notifications are best-effort */ }
});

// ---- File management: rename / move model file (batch-friendly IPC) ----
ipcMain.handle('rename-model-file', async (event, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const safe = String(newName).replace(/[<>:"|?*\\/]/g, '_').trim();
    if (!safe) return { ok: false, error: 'invalid name' };
    const newPath = path.join(dir, safe);
    if (fs.existsSync(newPath)) return { ok: false, error: '目标文件已存在' };
    fs.renameSync(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('move-model-files', async (event, filePaths, targetDir) => {
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const moved = [];
    const errors = [];
    for (let idx = 0; idx < filePaths.length; idx++) {
      const src = filePaths[idx];
      const name = path.basename(src);
      const dest = path.join(targetDir, name);
      try {
        if (fs.existsSync(dest)) { errors.push(name + ': target exists'); continue; }
        try {
          fs.renameSync(src, dest); // same volume: instant
        } catch (e) {
          // Cross-volume: streamed copy with progress, then remove the source.
          const total = fs.statSync(src).size;
          const read = fs.createReadStream(src);
          const write = fs.createWriteStream(dest);
          const started = Date.now();
          let done = 0;
          let lastSent = 0;
          for await (const chunk of read) {
            if (!write.write(chunk)) await new Promise((r) => write.once('drain', r));
            done += chunk.length;
            if (Date.now() - lastSent > 120 && mainWindow) {
              lastSent = Date.now();
              const pct = total ? done / total : 0;
              const eta = pct > 0 ? Math.round((Date.now() - started) * (1 - pct) / pct / 1000) : -1;
              emitFileProgress({ kind: 'move', name: name + ' (' + (idx + 1) + '/' + filePaths.length + ')', pct, done, total, eta });
            }
          }
          await new Promise((resolve, reject) => { write.end(resolve); write.once('error', reject); });
          fs.unlinkSync(src);
        }
        emitFileProgress({ kind: 'move', name, pct: 1, done: 1, total: 1, eta: 0 });
        moved.push(dest);
      } catch (e) {
        errors.push(name + ': ' + e.message);
      }
    }
    return { ok: true, moved, errors };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Runtime detection & one-click model launch ----
const { spawn, spawnSync } = require('child_process');

function findExecutable(name, extraDirs) {
  // PATH lookup
  const pathVar = process.env.PATH || '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = pathVar.split(path.delimiter).concat(extraDirs || []);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) {}
    }
  }
  return null;
}

ipcMain.handle('detect-runtimes', async () => {
  const home = app.getPath('home');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out = [];
  // Ollama — distinguish "installed" from "service running".
  const ollama = findExecutable('ollama', [
    path.join(local, 'Programs', 'Ollama'),
    path.join(home, '.ollama', 'bin'),
    'C:\\Program Files\\Ollama',
  ]);
  let ollamaRunning = false;
  try {
    const bl = await chat.detectBackends();
    const ob = bl.find((b) => b.key === 'ollama');
    ollamaRunning = !!(ob && ob.online);
  } catch (e) { /* ignore */ }
  out.push({
    key: 'ollama', name: 'Ollama', exe: ollama || '', found: !!ollama,
    running: ollamaRunning, hint: 'https://ollama.com/download',
  });
  // llama.cpp — the bundled engine counts as found.
  const eng = engine.detectEngines();
  const llamaServer = eng.bundled
    ? path.join(eng.bundled, 'llama-server.exe')
    : findExecutable('llama-server', [
      path.join(home, 'llama.cpp', 'build', 'bin', 'Release'),
      path.join(local, 'Programs', 'llama.cpp'),
    ]);
  out.push({
    key: 'llamacpp', name: 'llama.cpp', exe: llamaServer || '', found: !!llamaServer,
    running: engine.engineStatus().running, bundled: !!eng.bundled, vulkan: eng.vulkan,
    hint: 'https://github.com/ggml-org/llama.cpp',
  });
  // LM Studio — may live in a custom directory; chat.findLmStudio() checks
  // the standard paths plus the registry.
  const lm = chat.findLmStudio();
  out.push({ key: 'lmstudio', name: 'LM Studio', exe: lm || '', found: !!lm, hint: 'https://lmstudio.ai/download' });
  return out;
});

ipcMain.handle('launch-model', async (event, runtime, modelPath, opts) => {
  try {
    if (!fs.existsSync(modelPath)) return { ok: false, error: '模型文件不存在' };
    let exe, args = [], cwd;
    const home = app.getPath('home');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    if (runtime === 'llamacpp') {
      exe = findExecutable('llama-server', [
        path.join(home, 'llama.cpp', 'build', 'bin', 'Release'),
        path.join(local, 'Programs', 'llama.cpp'),
      ]);
      if (!exe) return { ok: false, error: '未找到 llama-server' };
      args = ['-m', modelPath, '--ctx-size', String((opts && opts.ctx) || 4096), '--host', '127.0.0.1', '--port', String((opts && opts.port) || 8080)];
    } else if (runtime === 'lmstudio') {
      const cands = [
        path.join(local, 'Programs', 'LM Studio', 'LM Studio.exe'),
        path.join(local, 'LM Studio', 'LM Studio.exe'),
        'C://Program Files\\LM Studio\\LM Studio.exe',
      ];
      exe = cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
      if (!exe) return { ok: false, error: '未找到 LM Studio' };
      // LM Studio has no reliable CLI to open a specific GGUF; just launch it.
      args = [];
    } else if (runtime === 'ollama') {
      exe = findExecutable('ollama', [path.join(local, 'Programs', 'Ollama')]);
      if (!exe) return { ok: false, error: '未找到 Ollama' };
      // Auto-import GGUF into Ollama: write a temp Modelfile, run `ollama create`, then `ollama run`.
      const name = String((opts && opts.name) || 'model').replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
      const modelfile = path.join(app.getPath('temp'), 'modellodge-' + Date.now() + '.Modelfile');
      fs.writeFileSync(modelfile, 'FROM ' + modelPath + '\n', 'utf8');
      try {
        const r = spawnSync(exe, ['create', name, '-f', modelfile], { encoding: 'utf8', timeout: 300000, windowsHide: true });
        if (r.status !== 0) return { ok: false, error: 'Ollama 导入失败：' + ((r.stderr || r.stdout || '').slice(0, 200) || '未知错误') };
      } finally {
        try { fs.unlinkSync(modelfile); } catch (_) {}
      }
      // launch interactive run in a new console window
      const child = spawn(exe, ['run', name], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { ok: true, pid: child.pid, exe, args: ['run', name], imported: true, modelName: name };
    } else {
      return { ok: false, error: '未知运行时' };
    }
    const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, pid: child.pid, exe, args };
  } catch (e) { return { ok: false, error: e.message }; }
});

// What runtimes are usable? Reports bundled engine + installed external apps.
ipcMain.handle('engine-detect', async () => {
  try {
    const e = await engine.detectEngines();
    return {
      ok: true,
      engine: {
        bundled: !!e.bundled,
        bundledPath: e.bundled || '',
        vulkan: e.vulkan,
        nvidia: e.nvidia,
        cuda: e.cuda,
        cudaCount: e.cudaCount || 0,
        cudaBackends: e.cudaBackends || [],
        externalCount: e.external.length,
        source: e.source,
      },
      status: engine.engineStatus(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Suggest conservative runtime parameters from VRAM + model size.
ipcMain.handle('engine-suggest', async (event, modelBytes, vramMB, freeMB) => {
  const vramBytes = (Number(vramMB) || 0) * 1024 * 1024;
  const freeBytes = (Number(freeMB) || 0) * 1024 * 1024;
  return {
    ok: true,
    ctx: engine.defaultContext(Number(vramMB) || 0, freeBytes ? Number(freeMB) : 0),
    gpuLayers: engine.suggestGpuLayers(Number(modelBytes) || 0, vramBytes, freeBytes),
  };
});

// Live dedicated VRAM usage (NVIDIA). Used for the chat-page meter and
// "spilling into shared memory" warning. Local only — no telemetry.
ipcMain.handle('vram-usage', async () => {
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve) => {
      execFile('nvidia-smi', [
        '--query-gpu=name,memory.used,memory.free,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits',
      ], { timeout: 5000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : (stdout || '')));
    });
    const gpus = [];
    for (const line of String(out).split(/\r?\n/)) {
      const p = line.split(',').map((s) => s.trim());
      if (p.length < 4) continue;
      const usedMB = parseFloat(p[1]);
      const freeMB = parseFloat(p[2]);
      const totalMB = parseFloat(p[3]);
      if (!isFinite(totalMB) || totalMB <= 0) continue;
      gpus.push({ name: p[0], usedMB: usedMB || 0, freeMB: freeMB || 0, totalMB, util: parseFloat(p[4]) || 0 });
    }
    return { ok: true, gpus };
  } catch (e) {
    return { ok: false, gpus: [], error: e.message };
  }
});

// Bundle local logs + non-secret settings into a zip on the Desktop.
ipcMain.handle('export-diagnostics', async () => {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    const logDir = logger.getLogDir();
    if (fs.existsSync(logDir)) {
      for (const name of fs.readdirSync(logDir)) {
        const p = path.join(logDir, name);
        try { if (fs.statSync(p).isFile()) zip.addLocalFile(p, 'logs'); } catch (_) {}
      }
    }
    for (const name of ['settings.json', 'folders.json', 'imported-models.json', 'chat-sessions.json']) {
      const p = path.join(app.getPath('userData'), name);
      try { if (fs.existsSync(p)) zip.addLocalFile(p, 'config'); } catch (_) {}
    }
    zip.addFile('README.txt', Buffer.from(
      'ModelLodge diagnostics bundle\n' +
      'Logs and non-secret configuration only. Tokens/secrets are NOT included.\n' +
      'Generated: ' + new Date().toISOString() + '\n', 'utf8'));
    const dest = path.join(app.getPath('desktop'), 'ModelLodge-diagnostics-' + Date.now() + '.zip');
    zip.writeZip(dest);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Remove stale engine caches the app itself created in userData / temp.
// The live engine under resources/llama is never touched.
ipcMain.handle('clean-old-engines', async () => {
  const candidates = [];
  const scan = (root) => {
    try {
      if (!fs.existsSync(root)) return;
      for (const name of fs.readdirSync(root)) {
        if (!/^(llama|engine|modellodge-engine)/i.test(name)) continue;
        const p = path.join(root, name);
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (!st.isDirectory()) continue;
        let bytes = 0;
        const walk = (d) => {
          try {
            for (const n of fs.readdirSync(d)) {
              const f = path.join(d, n);
              const s = fs.statSync(f);
              bytes += s.isDirectory() ? walk(f) : s.size;
            }
          } catch (_) {}
          return bytes;
        };
        walk(p);
        candidates.push({ path: p, bytes });
      }
    } catch (_) {}
  };
  scan(app.getPath('userData'));
  // Also handle engine caches named modellodge-engine-* in the temp root.
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (/^modellodge-engine-/i.test(name)) {
        const p = path.join(os.tmpdir(), name);
        if (fs.statSync(p).isDirectory() && !candidates.some((c) => c.path === p)) {
          let bytes = 0;
          const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); const s = fs.statSync(f); bytes += s.isDirectory() ? walk(f) : s.size; } return bytes; };
          try { bytes = walk(p); } catch (_) {}
          candidates.push({ path: p, bytes });
        }
      }
    }
  } catch (_) {}
  let freed = 0;
  const removed = [];
  for (const c of candidates) {
    try { fs.rmSync(c.path, { recursive: true, force: true }); freed += c.bytes; removed.push(c.path); } catch (_) {}
  }
  return { ok: true, removed, freedBytes: freed };
});

// ---- Optional CUDA component pack ---------------------------------------
// The main installer stays ~98 MB. Users who want CUDA on NVIDIA cards can
// download the separate component zip and import it here; it is unpacked into
// userData/cuda and the engine picks it up as the top-priority backend.
const CUDA_PACK_DIR = () => path.join(app.getPath('userData'), 'cuda');

// Open the public download page. The pack is ~713 MB, so let the browser /
// download manager handle it rather than streaming it through the app.
ipcMain.handle('cuda-pack-download', async () => {
  try {
    await shell.openExternal(CUDA_PACK_URL);
    return { ok: true, url: CUDA_PACK_URL };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cuda-pack-status', async () => {
  try {
    const dir = CUDA_PACK_DIR();
    const server = path.join(dir, 'llama-server.exe');
    const cudaDll = fs.existsSync(path.join(dir, 'ggml-cuda.dll'));
    let bytes = 0;
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const f = path.join(d, n);
        const s = fs.statSync(f);
        bytes += s.isDirectory() ? walk(f) : s.size;
      }
      return bytes;
    };
    if (fs.existsSync(dir)) { try { bytes = walk(dir); } catch (_) {} }
    const installed = fs.existsSync(server) && cudaDll;
    const driverVersion = await engine.nvidiaDriverVersion();
    return {
      ok: true, installed, dir, bytes,
      hasRuntime: engine.hasCudaRuntime(dir),
      driverVersion,
      driverWarning: engine.cudaDriverWarning(driverVersion),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cuda-pack-import', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择 CUDA 组件包（zip）',
      filters: [{ name: 'CUDA 组件包', extensions: ['zip'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    const zipPath = filePaths[0];
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    if (!entries.length) return { ok: false, error: '组件包是空的' };
    // SECURITY: reject path traversal entries before extracting anything.
    for (const e of entries) {
      const entryPath = e.entryName.split('/').join(path.sep);
      const full = path.resolve(CUDA_PACK_DIR(), entryPath);
      const rel = path.relative(CUDA_PACK_DIR(), full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, error: '组件包含有不安全的路径，已拒绝导入' };
      }
    }
    const dir = CUDA_PACK_DIR();
    const tmp = dir + '.tmp-' + Date.now();
    fs.mkdirSync(tmp, { recursive: true });
    zip.extractAllTo(tmp, true);
    // Accept both layouts: files at zip root, or inside a single top folder.
    let src = tmp;
    const top = fs.readdirSync(tmp, { withFileTypes: true });
    if (top.length === 1 && top[0].isDirectory() && !fs.existsSync(path.join(tmp, 'llama-server.exe'))) {
      src = path.join(tmp, top[0].name);
    }
    if (!fs.existsSync(path.join(src, 'llama-server.exe')) || !fs.existsSync(path.join(src, 'ggml-cuda.dll'))) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, error: '组件包缺少 llama-server.exe 或 ggml-cuda.dll，不是有效的 CUDA 组件包' };
    }
    // Runtime DLLs are mandatory: without cudart/cublasLt the server exits
    // with 0xC0000135 even though the CUDA backend itself is present.
    if (!engine.hasCudaRuntime(src)) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, error: '组件包缺少 CUDA 运行时 DLL（cudart/cublas/cublasLt），无法启动 CUDA' };
    }
    if (fs.existsSync(dir)) {
      const backup = dir + '.old-' + Date.now();
      try { fs.renameSync(dir, backup); } catch (_) {}
    }
    fs.renameSync(src, dir);
    if (src !== tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
    return { ok: true, dir, message: 'CUDA 组件包已安装，重启软件后生效' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cuda-pack-remove', async () => {
  try {
    const dir = CUDA_PACK_DIR();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- OpenAI-compatible API server (stable port + token auth) ----
ipcMain.handle('api-server-status', async () => {
  try { return { ok: true, ...apiServer.status() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// next: { enabled, lan, port, regenerateToken }. Persists to settings.json.
ipcMain.handle('api-server-configure', async (event, next) => {
  try {
    if (!next || typeof next !== 'object') return { ok: false, error: 'invalid config' };
    // Never let the renderer set the token directly; only regenerate it here.
    const cfgIn = {
      port: next.port,
      lan: !!next.lan,
      enabled: !!next.enabled,
      token: next.regenerateToken ? apiServer.regenerateToken() : undefined,
    };
    const r = apiServer.configure(cfgIn);
    const st = apiServer.status();
    appSettings.apiServer = {
      enabled: st.enabled, lan: st.lan, port: st.port, token: st.token,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
    return { ok: r.ok, error: r.error || st.error || '', status: st };
  } catch (e) {
    logger.error('api-server-configure failed', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api-server-token-regenerate', async () => {
  try {
    const token = apiServer.regenerateToken();
    const st = apiServer.status();
    appSettings.apiServer = {
      enabled: st.enabled, lan: st.lan, port: st.port, token,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
    return { ok: true, token };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Model health check (tier probe + per-model profile) ----
ipcMain.handle('model-check', async (event, modelPath, opts) => {
  try {
    const sender = event.sender;
    const report = await modelCheck.runCheck(modelPath, opts || {}, (p) => {
      if (!sender.isDestroyed()) sender.send('model-check-progress', p);
    });
    return { ok: true, report };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('model-check-cancel', async () => {
  try { modelCheck.cancelCheck(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('model-profile-get', async (event, modelPath) => {
  try { return { ok: true, profile: modelCheck.getProfile(app.getPath('userData'), modelPath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('model-profile-save', async (event, modelPath, profile) => {
  try {
    const saved = modelCheck.putProfile(app.getPath('userData'), modelPath, profile || {});
    return { ok: true, profile: saved };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('model-profile-remove', async (event, modelPath) => {
  try { modelCheck.removeProfile(app.getPath('userData'), modelPath); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Start the built-in engine on a GGUF file.
ipcMain.handle('engine-start', async (event, modelPath, opts) => {
  try {
    return await engine.startEngine(modelPath, opts || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('engine-stop', async () => {
  try {
    return engine.stopEngine();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Optional web search for chat. Only called when the user enables the toggle.
ipcMain.handle('web-search', async (event, query) => {
  try {
    const r = await websearch.searchWeb(query);
    if (r.ok) r.context = websearch.buildContextMessage(r.results, query);
    return r;
  } catch (err) {
    return { ok: false, results: [], error: err.message || String(err) };
  }
});

// Abort an in-flight generation. The renderer passes the request id it created
// when sending; we destroy the real socket so the GPU stops working immediately.
ipcMain.handle('engine-abort', async (event, reqId) => {
  try {
    return { ok: engine.abortChat(reqId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('chat-abort', async (event, reqId) => {
  try {
    return { ok: chat.abortChat(reqId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Chat against the built-in engine (llama.cpp OpenAI-compatible endpoint).
ipcMain.handle('engine-chat', async (event, messages, opts) => {
  const sender = event.sender;
  try {
    const st = engine.engineStatus();
    if (!st.running) return { ok: false, error: '引擎未运行' };
    const result = await engine.streamChat(st.port, messages, (delta) => {
      if (!sender.isDestroyed()) sender.send('chat-delta', { delta });
    }, opts || {});
    return { ok: true, content: result.content, aborted: !!result.aborted };
  } catch (err) {
    logger.error('engine-chat failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// Start the Ollama service if it is installed but not running.
ipcMain.handle('chat-start-ollama', async () => {
  try {
    return await chat.startOllamaService();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Clear a stuck Ollama CUDA context (cudaMalloc fails while VRAM is free).
ipcMain.handle('chat-restart-ollama', async () => {
  try {
    return await chat.restartOllamaService();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat-start-lmstudio', async (event, port) => {
  try {
    return await chat.startLmStudioService(port);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat-detect', async () => {
  try {
    const backends = await chat.detectBackends();
    return { ok: true, backends };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat-start-llama', async (event, modelPath, opts) => {
  try {
    return await chat.startLlamaServer(modelPath, opts);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Streaming chat: deltas are pushed to the renderer as 'chat-delta' events.
ipcMain.handle('chat-send', async (event, backendKey, modelName, messages, opts) => {
  const sender = event.sender;
  try {
    const result = await chat.streamChat(backendKey, modelName, messages, (delta) => {
      if (!sender.isDestroyed()) sender.send('chat-delta', { delta });
    }, opts);
    return { ok: true, content: result.content, aborted: !!result.aborted };
  } catch (err) {
    logger.error('chat-send failed', err);
    return { ok: false, error: err.message || String(err) };
  }
});
