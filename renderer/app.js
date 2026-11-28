const ML = window.api; // renamed from "api" to avoid collision with contextBridge global

// ---- Local error logging (forwarded to main process file, never uploaded) ----
window.addEventListener('error', (e) => {
  try { ML.log('error', 'window.onerror: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { ML.log('error', 'unhandledrejection: ' + String(e.reason && e.reason.message || e.reason)); } catch (_) {}
});

const state = {
  folders: [],
  models: [],
  notes: {},
  search: '',
  sort: 'name',
  view: 'all',
  arch: '',
  quant: '',
  fitOnly: false,
  currentModel: null,
  // download state
  hfModels: [],
  hfSelected: null,
  downloads: {},   // id -> { id, name, status, loaded, total, speed, error }
  downloadDir: null,
  downloadSeq: 0,
  gpus: [],
  brands: [],
  cols: { arch: true, quant: true, ctx: true, params: true },
};

const el = {
  folderList: document.getElementById('folder-list'),
  archList: document.getElementById('arch-list'),
  modelList: document.getElementById('model-list'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDesc: document.getElementById('empty-desc'),
  searchInput: document.getElementById('search-input'),
  sortSelect: document.getElementById('sort-select'),
  quantSelect: document.getElementById('quant-select'),
  statCount: document.getElementById('stat-count'),
  statSize: document.getElementById('stat-size'),
  statFolders: document.getElementById('stat-folders'),
  countAll: document.getElementById('count-all'),
  statusText: document.getElementById('status-text'),
  toast: document.getElementById('toast'),
  btnRefresh: document.getElementById('btn-refresh'),
  drawer: document.getElementById('drawer'),
  drawerOverlay: document.getElementById('drawer-overlay'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerArchBadge: document.getElementById('drawer-arch-badge'),
  detailGrid: document.getElementById('detail-grid'),
  detailTags: document.getElementById('detail-tags'),
  detailNote: document.getElementById('detail-note'),
  detailPath: document.getElementById('detail-path'),
  cmdLlamaserver: document.getElementById('cmd-llamaserver'),
  cmdOllama: document.getElementById('cmd-ollama'),
  aboutModal: document.getElementById('about-modal'),
  aboutVersion: document.getElementById('about-version'),
  aboutDetails: document.getElementById('about-details'),
  aboutClose: document.getElementById('about-close'),
  settingsModal: document.getElementById('settings-modal'),
  settingsClose: document.getElementById('settings-close'),
  settingsFolders: document.getElementById('settings-folders'),
  settingsAddFolder: document.getElementById('settings-add-folder'),
  settingsDepth: document.getElementById('settings-depth'),
  settingsHfToken: document.getElementById('settings-hf-token'),
  settingsTokenStatus: document.getElementById('settings-token-status'),
  settingsProxy: document.getElementById('settings-proxy'),
  settingsConflict: document.getElementById('settings-conflict'),
  settingsConcurrent: document.getElementById('settings-concurrent'),
  settingsMirrorResult: document.getElementById('settings-mirror-result'),
  settingsResetNotes: document.getElementById('settings-reset-notes'),
  libraryView: document.getElementById('library-view'),
  downloadView: document.getElementById('download-view'),
  hfSearchInput: document.getElementById('hf-search-input'),
  hfSourceSelect: document.getElementById('hf-source-select'),
  hfResults: document.getElementById('hf-results'),
  hfHint: document.getElementById('hf-hint'),
  modelDetail: document.getElementById('model-detail'),
  detailEmpty: document.getElementById('detail-empty'),
  mdTitle: document.getElementById('md-title'),
  mdStats: document.getElementById('md-stats'),
  mdDesc: document.getElementById('md-desc'),
  mdTags: document.getElementById('md-tags'),
  mdOptions: document.getElementById('md-options'),
  mdReadme: document.getElementById('md-readme'),
  chatView: document.getElementById('chat-view'),
  chatBackends: document.getElementById('chat-backends'),
  chatModelSelect: document.getElementById('chat-model-select'),
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('btn-chat-send'),
  chatStop: document.getElementById('btn-chat-stop'),
  chatStatus: document.getElementById('chat-status'),
  chatTemp: document.getElementById('chat-temp'),
  chatTempVal: document.getElementById('chat-temp-val'),
  chatCtx: document.getElementById('chat-ctx'),
  chatGpu: document.getElementById('chat-gpu'),
  chatNgl: document.getElementById('chat-ngl'),
  chatBackendPref: document.getElementById('chat-backend-pref'),
  chatVram: document.getElementById('chat-vram'),
  chatVramText: document.getElementById('chat-vram-text'),
  chatVramFill: document.getElementById('chat-vram-fill'),
  chatVramWarn: document.getElementById('chat-vram-warn'),
  chatCudaHint: document.getElementById('chat-cuda-hint'),
  fileProgress: document.getElementById('file-progress'),
  fileProgressName: document.getElementById('file-progress-name'),
  fileProgressPct: document.getElementById('file-progress-pct'),
  fileProgressFill: document.getElementById('file-progress-fill'),
  fileProgressEta: document.getElementById('file-progress-eta'),
  downloadQueue: document.getElementById('download-queue'),
  downloadCount: document.getElementById('download-count'),
  downloadDirText: document.getElementById('download-dir-text'),
  detailFit: document.getElementById('detail-fit'),
  detailSha: document.getElementById('detail-sha'),
};

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 10 ? 1 : 2) + ' ' + units[i];
}

function formatDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const diff = now - d;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatParamCount(n) {
  if (!n) return null;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  return String(n);
}

function iconLetters(name) {
  const m = name.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*[bB](?=$|[^a-zA-Z0-9])/);
  if (m) return m[1] + 'B';
  const letters = name.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();
  return letters || 'GGUF';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
// ---- Drag & drop: drop model files/folders onto the library to add their folders ----
['dragenter', 'dragover'].forEach((evt) => {
  el.libraryView.addEventListener(evt, (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
});
el.libraryView.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  const paths = files.map(f => f.path).filter(Boolean);
  if (!paths.length) { showToast('无法获取拖入文件路径'); return; }
  const r = await ML.importDroppedPaths(paths, state.folders);
  if (r && r.ok) {
    if (r.added > 0) {
      state.folders = r.folders;
      renderFolders();
      await refreshModels();
      showToast('已导入 ' + r.added + ' 个文件夹');
    } else {
      showToast('这些文件夹已在库中');
    }
  } else {
    showToast('导入失败：' + (r.error || '未知错误'));
  }
});

// ---- Theme (light / dark / system) ----
function applyTheme(mode) {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

document.getElementById('settings-theme').addEventListener('change', async (e) => {
  const mode = e.target.value;
  applyTheme(mode);
  const settings = await ML.loadSettings();
  settings.theme = mode;
  await ML.saveSettings(settings);
});

// ---- Language switching ----
document.getElementById('settings-lang').addEventListener('change', async (e) => {
  const lang = e.target.value;
  applyLanguage(lang);
  const settings = await ML.loadSettings();
  settings.lang = lang;
  await ML.saveSettings(settings);
  // re-render dynamic lists so their generated text follows the new language
  try { renderModels(); renderDownloadQueue(); } catch (_) {}
  showToast(lang === 'zh' ? '界面语言已切换' : lang === 'en' ? 'Language switched to English' : '言語を日本語に切り替えました');
});

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

// Long-running file work (SHA256 / cross-drive move) shows a real progress bar.
let progressHideTimer = null;
if (ML.onFileProgress) ML.onFileProgress((p) => {
  if (!el.fileProgress || !p) return;
  clearTimeout(progressHideTimer);
  el.fileProgress.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, Math.round((p.pct || 0) * 100)));
  el.fileProgressName.textContent = (p.kind === 'sha256' ? '校验 ' : '移动 ') + (p.name || '');
  el.fileProgressPct.textContent = pct + '%';
  el.fileProgressFill.style.width = pct + '%';
  el.fileProgressEta.textContent = p.eta > 0 ? ('预计剩余 ' + p.eta + ' 秒') : '';
  if (pct >= 100) progressHideTimer = setTimeout(() => el.fileProgress.classList.add('hidden'), 1200);
});

// ---- GPU fit assessment (mirrors vram.js logic for instant UI) ----
function assessFitLocal(modelBytes, gpuOverride) {
  const gpu = gpuOverride || (state.gpus && state.gpus[0]);
  if (!gpu || !gpu.vramBytes || !modelBytes) {
    return { level: 'unknown', label: '未知', detail: '无法判断', ratio: null };
  }
  const reserve = gpu.vramBytes > 4 * 1024 ** 3 ? 0.6 * 1024 ** 3 : 0.3 * 1024 ** 3;
  const usable = Math.max(0.5 * 1024 ** 3, gpu.vramBytes - reserve);
  const ratio = modelBytes / usable;
  if (ratio <= 0.92) return { level: 'good', label: '显存充足', detail: '模型可完整载入显存', ratio: Math.round(ratio * 100) / 100, usable };
  if (ratio <= 1.4) return { level: 'tight', label: '显存稍不足', detail: '勉强可运行，可能需要部分卸载到内存', ratio: Math.round(ratio * 100) / 100, usable };
  return { level: 'bad', label: '显存完全不足', detail: '超出显存太多，无法直接载入', ratio: Math.round(ratio * 100) / 100, usable };
}

function fitBadgeHtml(fit) {
  return `<span class="fit-badge ${fit.level}">${esc(fit.label)}</span>`;
}

function gpuSizeText(g) {
  if (!g || !g.vramMB) return '未知';
  return g.vramMB >= 1024 ? (g.vramMB / 1024).toFixed(1) + ' GB' : Math.round(g.vramMB) + ' MB';
}

function gpuShortName(g) {
  return g.name
    .replace(/NVIDIA GeForce /i, '')
    .replace(/ Laptop GPU/i, '')
    .replace(/ Intel\(R\) /i, '')
    .replace(/ AMD /i, '');
}

function renderGpuInfo() {
  const list = document.getElementById('gpu-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.gpus.length) {
    list.innerHTML = '<div class="gpu-item">未检测到显卡</div>';
    return;
  }
  state.gpus.forEach((g) => {
    const item = document.createElement('div');
    item.className = 'gpu-item' + (g.integrated ? ' integrated' : '');
    item.title = g.name + ' · 显存 ' + gpuSizeText(g) + (g.integrated ? ' (共享系统内存)' : '') + ' · 来源 ' + g.source;
    item.innerHTML = `
      <span class="gpu-dot"></span>
      <span class="gpu-name">${esc(gpuShortName(g))}</span>
      <span class="gpu-size">${gpuSizeText(g)}</span>
    `;
    list.appendChild(item);
  });
}

function renderSettingsGpus() {
  const box = document.getElementById('settings-gpus');
  if (!box) return;
  box.innerHTML = '';
  if (!state.gpus.length) {
    box.innerHTML = '<div class="cmd-hint">未检测到显卡</div>';
    return;
  }
  state.gpus.forEach((g) => {
    const item = document.createElement('div');
    item.className = 'settings-gpu-item';
    const brand = g.brand || { short: g.vendor || '未知', name: '未知品牌', origin: '未知' };
    const brandClass = brand.origin === '国产' ? 'domestic' : brand.key === 'amd' ? 'amd' : brand.key === 'intel' ? 'intel' : '';
    const sourceText = g.source === 'nvidia-smi' ? '驱动精确读取' : g.source === 'registry-qword' ? '注册表精确读取' : '系统接口读取（>4GB 可能偏小）';
    item.innerHTML = `
      <div class="row1">
        <span class="gname">${esc(g.name)}</span>
        <span class="gbrand ${brandClass}">${brand.origin === '国产' ? '国产 · ' : ''}${esc(brand.short)}</span>
      </div>
      <div class="gmeta">
        品牌：<b>${esc(brand.name)}</b> · 显存：<b>${gpuSizeText(g)}</b> · ${g.integrated ? '核显（共享系统内存）' : '独立显存'} · ${esc(sourceText)}
      </div>
    `;
    box.appendChild(item);
  });
}

// Render fit assessment for every detected GPU in the detail drawer
function renderBrandLegend() {
  const box = document.getElementById('settings-brands');
  if (!box || !state.brands.length) return;
  box.innerHTML = state.brands.map((b) =>
    `<span class="brand-chip ${b.origin === '国产' ? 'domestic' : ''}" title="${esc(b.name)} · ${esc(b.origin)}">${esc(b.short)}</span>`
  ).join('');
}

function renderFitForModel(m) {
  const box = el.detailFit;
  if (!box) return;
  if (!state.gpus.length) {
    box.innerHTML = '<div class="fit-desc">未检测到显卡，无法判断显存适配。</div>';
    return;
  }
  const rows = state.gpus.map((g) => {
    const fit = assessFitLocal(m.size, g);
    const usableText = fit.usable ? formatSize(fit.usable) : '未知';
    const barPct = fit.ratio ? Math.min(100, Math.round(fit.ratio * 70)) : 0;
    const tag = g.integrated ? '<span class="gbrand intel" style="font-size:9px;padding:0 4px;margin-left:4px">核显·共享内存</span>' : '';
    return `
      <div style="margin-bottom:10px">
        <div class="fit-main">
          ${fitBadgeHtml(fit)}
          <span style="font-size:11px;color:var(--text-tertiary)">${gpuSizeText(g)}${tag}</span>
        </div>
        <div class="fit-desc">${esc(gpuShortName(g))} · 可用 ${usableText} · ${esc(fit.detail)}</div>
        <div class="fit-bar-bg"><div class="fit-bar ${fit.level}" style="width:${barPct}%"></div></div>
      </div>
    `;
  });
  box.innerHTML = `
    <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:8px">模型 ${formatSize(m.size)} · 按每张显卡分别判断</div>
    ${rows.join('')}
  `;
}

function noteFor(m) {
  const raw = state.notes[m.path];
  if (typeof raw === 'string') return { tags: [], note: raw };
  if (raw && typeof raw === 'object') return raw;
  return { tags: [], note: '' };
}

function renderFolders() {
  el.folderList.innerHTML = '';
  state.folders.forEach((folder, index) => {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.title = folder;
    const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
    item.innerHTML = `
      <svg viewBox="0 0 24 24" class="nav-icon"><path d="M4 7h6l2 2h8v10H4z"/></svg>
      <span class="folder-name">${esc(name)}</span>
      <button class="folder-remove" data-index="${index}" title="移除文件夹">&times;</button>
    `;
    item.querySelector('.folder-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      state.folders.splice(index, 1);
      await ML.saveFolders(state.folders);
      renderFolders();
      await refreshModels();
    });
    el.folderList.appendChild(item);
  });
  el.statFolders.textContent = state.folders.length;
}

function renderArchFilters() {
  const counts = {};
  state.models.forEach((m) => {
    const a = (m.meta && m.meta.architecture) || '未知';
    counts[a] = (counts[a] || 0) + 1;
  });
  const archs = Object.keys(counts).sort();
  el.archList.innerHTML = '';
  const makeItem = (key, label, count, active) => {
    const item = document.createElement('div');
    item.className = 'filter-item' + (active ? ' active' : '');
    item.innerHTML = `<span class="filter-name">${esc(label)}</span><span class="filter-count">${count}</span>`;
    item.addEventListener('click', () => {
      state.arch = key;
      renderArchFilters();
      renderModels();
    });
    el.archList.appendChild(item);
  };
  makeItem('', '所有架构', state.models.length, state.arch === '');
  archs.forEach((a) => makeItem(a, a, counts[a], state.arch === a));
}

function renderQuantOptions() {
  const quants = new Set();
  state.models.forEach((m) => {
    const q = m.meta && m.meta.quantization;
    if (q) quants.add(q);
  });
  const current = state.quant;
  el.quantSelect.innerHTML = '<option value="">全部</option>';
  [...quants].sort().forEach((q) => {
    const opt = document.createElement('option');
    opt.value = q;
    opt.textContent = q;
    el.quantSelect.appendChild(opt);
  });
  el.quantSelect.value = quants.has(current) ? current : '';
  state.quant = el.quantSelect.value;
}

function getVisibleModels() {
  let list = [...state.models];
  if (state.arch) {
    list = list.filter((m) => ((m.meta && m.meta.architecture) || '未知') === state.arch);
  }
  if (state.quant) {
    list = list.filter((m) => m.meta && m.meta.quantization === state.quant);
  }
  if (state.fitOnly) {
    // Hide versions that cannot fit in the fastest discrete GPU at all.
    list = list.filter((m) => {
      const g = state.gpus.find((x) => !x.integrated) || state.gpus[0];
      return g ? assessFitLocal(m.size, g).level !== 'bad' : true;
    });
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    // Fuzzy: subsequence match ("qwen7b" matches "qwen2.5-7b-instruct")
    const fuzzy = (text) => {
      if (!text) return false;
      const t = text.toLowerCase();
      if (t.includes(q)) return true;
      let qi = 0;
      for (const ch of t) { if (ch === q[qi]) qi++; if (qi === q.length) return true; }
      return false;
    };
    list = list.filter((m) => {
      if (fuzzy(m.name) || fuzzy(m.path) || fuzzy(m.origin)) return true;
      const nm = noteFor(m);
      if (nm.note && fuzzy(nm.note)) return true;
      if (nm.tags && nm.tags.some((t) => fuzzy(t))) return true;
      return false;
    });
  }
  // favorites always pinned to the top; secondary sort by chosen field
  const favFirst = (a, b) => (noteFor(b).favorite ? 1 : 0) - (noteFor(a).favorite ? 1 : 0);
  switch (state.sort) {
    case 'size': list.sort((a, b) => favFirst(a, b) || b.size - a.size); break;
    case 'modified': list.sort((a, b) => favFirst(a, b) || b.modified - a.modified); break;
    case 'context':
      list.sort((a, b) => favFirst(a, b) || ((b.meta && b.meta.contextLength) || 0) - ((a.meta && a.meta.contextLength) || 0));
      break;
    default: list.sort((a, b) => favFirst(a, b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  if (state.view === 'recent') {
    const byDate = [...list].sort((a, b) => b.modified - a.modified);
    const recentPaths = new Set(byDate.slice(0, 10).map((m) => m.path));
    list = list.filter((m) => recentPaths.has(m.path));
  }
  return list;
}

function renderModels() {
  const list = getVisibleModels();
  el.statCount.textContent = list.length;
  el.countAll.textContent = state.models.length;
  // parse-failure status button (GGUF header parse errors only)
  const parseFails = state.models.filter(m => m.meta && m.meta.ok === false && !m.meta.noHeader).length;
  const pw = document.getElementById('stat-parse-wrap');
  if (pw) {
    pw.style.display = parseFails > 0 ? '' : 'none';
    document.getElementById('stat-parse').textContent = parseFails;
    pw.title = parseFails + ' 个 GGUF 文件解析失败（点此筛选）';
  }

  let totalSize = 0;
  list.forEach((m) => totalSize += m.size);
  el.statSize.textContent = formatSize(totalSize);
  // dashboard extras
  const gpuEl = document.getElementById('stat-gpus');
  if (gpuEl) gpuEl.textContent = state.gpus.length;
  const fmtEl = document.getElementById('stat-formats');
  if (fmtEl) {
    const counts = {};
    state.models.forEach(m => { const t = (m.type || (m.ext ? m.ext.toUpperCase() : 'GGUF')); counts[t] = (counts[t] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    fmtEl.textContent = top.length ? top.map(([k, v]) => k + ' ' + v).join(' / ') : '-';
    fmtEl.title = '格式分布：' + Object.entries(counts).map(([k, v]) => k + ': ' + v).join(', ');
  }

  if (list.length === 0) {
    el.modelList.style.display = 'none';
    el.emptyState.classList.remove('hidden');
    if (state.models.length === 0) {
      el.emptyTitle.textContent = t('empty.noModels');
      el.emptyDesc.textContent = t('empty.noModelsDesc');
    } else {
      el.emptyTitle.textContent = t('empty.noMatch');
      el.emptyDesc.textContent = t('empty.noMatchDesc');
    }
    return;
  }

  el.modelList.style.display = 'block';
  el.emptyState.classList.add('hidden');
  el.modelList.innerHTML = '';

  list.forEach((m) => {
    const meta = m.meta || {};
    const nm = noteFor(m);
    const badges = [];
    if (nm.favorite) badges.push('<span class="card-tag" style="color:#e6a700">★ 收藏</span>');
    // Variant indicator: same base model name with different quantizations
    const baseName = m.name.replace(/(iq\d[\w_]*|q\d[\w_]*|fp16|fp32|bf16|f16|f32)/ig, '').replace(/[._\-]+$/g, '');
    const variantCount = state.models.filter(x => x !== m && x.name.replace(/(iq\d[\w_]*|q\d[\w_]*|fp16|fp32|bf16|f16|f32)/ig, '').replace(/[._\-]+$/g, '') === baseName).length;
    if (variantCount > 0) badges.push(`<span class="card-tag" title="同模型有其他量化版本">${variantCount + 1} 个变体</span>`);
    if (m.origin) badges.push(`<span class="card-tag" title="来自 ${esc(m.origin)}">${esc(m.origin)}</span>`);
    if (m.type && m.type !== 'GGUF') badges.push(`<span class="card-tag">${esc(m.type)}</span>`);
    if (state.cols.quant && meta.quantization) badges.push(`<span class="card-tag quant">${esc(meta.quantization)}</span>`);
    if (state.cols.arch && meta.architecture) badges.push(`<span class="card-tag">${esc(meta.architecture)}</span>`);
    if (state.cols.ctx && meta.contextLength) badges.push(`<span class="card-tag ctx">${Math.round(meta.contextLength / 1024)}K 上下文</span>`);
    const param = formatParamCount(meta.parameterCount);
    if (state.cols.params && param) badges.push(`<span class="card-tag">${esc(param)} 参数</span>`);
    if (nm.tags && nm.tags.length) {
      nm.tags.forEach((t) => badges.push(`<span class="card-tag usertag">${esc(t)}</span>`));
    }
    const fit = assessFitLocal(m.size);
    badges.push(fitBadgeHtml(fit));

    const card = document.createElement('div');
    card.className = 'model-card';
    card.innerHTML = `
      <div class="model-icon">${esc(iconLetters(m.name))}</div>
      <div class="model-info">
        <div class="model-name" title="${esc(m.name)}">${esc(m.name)}</div>
        <div class="model-meta">
          <span><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>${formatSize(m.size)}</span>
          <span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${formatDate(m.modified)}</span>
        </div>
        ${badges.length ? `<div class="card-badges">${badges.join('')}</div>` : ''}
        ${nm.note ? `<div class="card-note">${esc(nm.note)}</div>` : ''}
        <div class="model-path" title="${esc(m.path)}">${esc(m.path)}</div>
      </div>
      <div class="model-actions">
        <button class="action-btn" data-action="detail" data-path="${esc(m.path)}" title="查看详情">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
        </button>
        <button class="action-btn" data-action="folder" data-path="${esc(m.path)}" title="在文件夹中显示">
          <svg viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4z"/></svg>
        </button>
        <button class="action-btn" data-action="copy" data-path="${esc(m.path)}" title="复制完整路径">
          <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
        </button>
      </div>
    `;
    card.querySelectorAll('.action-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const p = btn.getAttribute('data-path');
        const action = btn.getAttribute('data-action');
        if (action === 'detail') {
          openDrawer(p);
          return;
        }
        try {
          if (action === 'folder') {
            const ok = await ML.showInFolder(p);
            if (!ok) showToast('文件夹打开失败，路径可能已失效');
          } else {
            await ML.copyText(p);
            showToast('路径已复制到剪贴板');
          }
        } catch (err) {
          showToast('操作失败：' + (err && err.message ? err.message : '未知错误'));
        }
      });
    });
    card.addEventListener('click', () => openDrawer(m.path));
    el.modelList.appendChild(card);
  });
}

// ---- Detail drawer ----
function findModel(p) {
  return state.models.find((m) => m.path === p) || null;
}

// Display-only command preview. The real engine launch uses spawn(exe, args[])
// in engine.js (never a concatenated command line), so spaces / CJK paths are safe.
function quoteWinArg(arg) {
  const s = String(arg);
  return /^[\w.\-]+$/.test(s) ? s : '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function buildCommands(m) {
  const ctx = (m.meta && m.meta.contextLength) || 4096;
  const serverArgs = ['llama-server', '-m', m.path, '--ctx-size', String(ctx)].map(quoteWinArg).join(' ');
  const ollamaArgs = ['ollama', 'create', 'mymodel', '-f', 'Modelfile'].map(quoteWinArg).join(' ');
  return {
    server: serverArgs,
    ollama: ollamaArgs + '  # Modelfile: FROM ' + quoteWinArg(m.path),
  };
}

// ---- Runtime detection / one-click launch ----
let detectedRuntimes = null;
async function renderRuntimes(m) {
  const box = document.getElementById('runtime-list');
  if (!box) return;
  if (!detectedRuntimes) {
    try { detectedRuntimes = await ML.detectRuntimes(); } catch (_) { detectedRuntimes = []; }
  }
  const isGGUF = /\.gguf$/i.test(m.name);
  if (!isGGUF) {
    box.innerHTML = '<div class="cmd-hint">该格式不能直接用运行时加载，仅 GGUF 支持一键启动。</div>';
    return;
  }
  box.innerHTML = '';
  detectedRuntimes.forEach(rt => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--hover-bg);border-radius:6px';
    const status = rt.found
      ? '<span style="color:#2e9e5b;font-size:11px">● 已安装</span>'
      : '<span style="color:var(--text-tertiary);font-size:11px">○ 未安装</span>';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;font-size:12px';
    label.innerHTML = '<b>' + esc(rt.name) + '</b> ' + status;
    row.appendChild(label);
    const btn = document.createElement('button');
    btn.className = 'secondary-btn small-btn';
    btn.textContent = rt.found ? '一键启动' : '下载';
    btn.addEventListener('click', async () => {
      if (!rt.found) {
        await ML.openExternal(rt.hint);
        showToast('已在浏览器打开 ' + rt.name + ' 下载页');
        return;
      }
      btn.disabled = true; btn.textContent = t('chat.starting');
      const ctx = (m.meta && m.meta.contextLength) || 4096;
      const r = await ML.launchModel(rt.key, m.path, { ctx, name: m.name.replace(/\.gguf$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() });
      btn.disabled = false; btn.textContent = '一键启动';
      if (r.ok) showToast(rt.name + ' 已启动' + (r.imported ? '（已导入为 ' + r.modelName + '）' : '') + ' PID ' + r.pid);
      else if (r.needsManual) { await ML.copyText(r.command); showToast('需手动执行，命令已复制：' + r.command); }
      else showToast('启动失败：' + (r.error || '未知错误'));
    });
    row.appendChild(btn);
    box.appendChild(row);
  });
}

function openDrawer(filePath) {
  const m = findModel(filePath);
  if (!m) return;
  state.currentModel = m;
  const meta = m.meta || {};
  const nm = noteFor(m);

  el.drawerTitle.textContent = m.name;
  el.drawerTitle.title = m.name;
  el.drawerArchBadge.textContent = meta.architecture || '未知架构';
  el.detailTags.value = (nm.tags || []).join(', ');
  el.detailNote.value = nm.note || '';
  document.getElementById('btn-favorite').textContent = nm.favorite ? '★ 已收藏' : '☆ 收藏';
  el.detailPath.textContent = m.path;
  el.detailSha.textContent = '';
  el.detailSha.removeAttribute('data-cmd');
  const shardsEl = document.getElementById('detail-shards');
  if (shardsEl) shardsEl.textContent = '';
  const shardSection = document.getElementById('detail-shard-section');
  if (shardSection) shardSection.style.display = /\.safetensors$/i.test(m.name) ? '' : 'none';

  const cells = [
    ['文件名', m.name],
    ['文件大小', formatSize(m.size)],
    ['量化类型', meta.quantization || '未知'],
    ['GGUF 版本', meta.version || '未知'],
    ['上下文长度', meta.contextLength ? meta.contextLength.toLocaleString() : '未知'],
    ['参数量', formatParamCount(meta.parameterCount) || '未知'],
    ['词表大小', meta.vocabSize ? meta.vocabSize.toLocaleString() : '未知'],
    ['模型名称', meta.name || '未知'],
    ['张量数量', meta.tensorCount != null ? meta.tensorCount : '未知'],
    ['块数', meta.blockCount != null ? meta.blockCount : '未知'],
  ];
  el.detailGrid.innerHTML = cells.map(([k, v]) => `
    <div class="detail-cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>
  `).join('');

  // VRAM fit — show assessment for EVERY detected GPU
  renderFitForModel(m);

  renderRuntimes(m); // async, fills the quick-launch section

  const cmd = buildCommands(m);
  el.cmdLlamaserver.textContent = cmd.server;
  el.cmdOllama.textContent = cmd.ollama;
  el.cmdLlamaserver.setAttribute('data-cmd', cmd.server);
  el.cmdOllama.setAttribute('data-cmd', cmd.ollama);

  el.drawer.classList.remove('hidden');
  el.drawerOverlay.classList.remove('hidden');
}

function closeDrawer() {
  el.drawer.classList.add('hidden');
  el.drawerOverlay.classList.add('hidden');
  state.currentModel = null;
}

async function refreshModels() {
  el.statusText.textContent = '扫描中...';
  el.btnRefresh.classList.add('spinning');
  try {
    state.models = await ML.scanModels(state.folders);
    renderArchFilters();
    renderQuantOptions();
    renderModels();
    el.statusText.textContent = '就绪';
  } catch (err) {
    el.statusText.textContent = '错误';
    showToast('扫描失败');
  } finally {
    el.btnRefresh.classList.remove('spinning');
  }
}

async function addFolder() {
  const dir = await ML.pickDirectory();
  if (!dir) return;
  if (!state.folders.includes(dir)) {
    state.folders.push(dir);
    await ML.saveFolders(state.folders);
    renderFolders();
  }
  await refreshModels();
}

// ---- Event bindings ----
document.getElementById('btn-add-folder').addEventListener('click', addFolder);
document.getElementById('btn-empty-add').addEventListener('click', addFolder);
el.btnRefresh.addEventListener('click', refreshModels);

el.searchInput.addEventListener('input', (e) => {
  state.search = e.target.value;
  renderModels();
});

el.sortSelect.addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderModels();
});

el.quantSelect.addEventListener('change', (e) => {
  state.quant = e.target.value;
  renderModels();
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    state.view = item.getAttribute('data-view');
    el.libraryView.classList.add('hidden');
    el.downloadView.classList.add('hidden');
    el.chatView.classList.add('hidden');
    const toolsView = document.getElementById('tools-view');
    if (toolsView) toolsView.classList.add('hidden');
    if (state.view === 'download') {
      el.downloadView.classList.remove('hidden');
    } else if (state.view === 'chat') {
      el.chatView.classList.remove('hidden');
      initChatView();
    } else if (state.view === 'tools') {
      if (toolsView) {
        toolsView.classList.remove('hidden');
        initToolsView();
      }
    } else {
      el.libraryView.classList.remove('hidden');
      renderModels();
    }
  });
});

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
el.drawerOverlay.addEventListener('click', closeDrawer);

document.getElementById('btn-favorite').addEventListener('click', async () => {
  if (!state.currentModel) return;
  const nm = noteFor(state.currentModel);
  nm.favorite = !nm.favorite;
  const ok = await ML.saveNote(state.currentModel.path, nm);
  if (ok) {
    state.notes[state.currentModel.path] = nm;
    document.getElementById('btn-favorite').textContent = nm.favorite ? '★ 已收藏' : '☆ 收藏';
    showToast(nm.favorite ? '已收藏（置顶显示）' : '已取消收藏');
    renderModels();
  }
});
document.getElementById('btn-rename').addEventListener('click', async () => {
  if (!state.currentModel) return;
  const cur = state.currentModel.name;
  const next = prompt('重命名文件（保留扩展名）：', cur);
  if (!next || next === cur) return;
  const r = await ML.renameModelFile(state.currentModel.path, next);
  if (r.ok) { showToast('已重命名'); state.currentModel.path = r.path; state.currentModel.name = r.path.split('\\').pop().split('/').pop(); await refreshModels(); }
  else showToast('重命名失败：' + r.error);
});

document.getElementById('btn-move').addEventListener('click', async () => {
  if (!state.currentModel) return;
  const dir = await ML.pickDirectory();
  if (!dir) return;
  const r = await ML.moveModelFiles([state.currentModel.path], dir);
  if (r.ok && r.moved.length) { showToast('已移动到：' + dir); await refreshModels(); }
  else showToast('移动失败：' + (r.errors?.join('; ') || r.error || '未知错误'));
});

document.getElementById('btn-save-note').addEventListener('click', async () => {
  if (!state.currentModel) return;
  const tags = el.detailTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const note = el.detailNote.value.trim();
  const ok = await ML.saveNote(state.currentModel.path, { tags, note });
  if (ok) {
    state.notes[state.currentModel.path] = { tags, note };
    showToast('标签和备注已保存');
    renderModels();
  } else {
    showToast('保存失败');
  }
});

document.querySelectorAll('.cmd-copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = document.getElementById('cmd-' + btn.getAttribute('data-cmd'));
    const text = target ? target.getAttribute('data-cmd') : '';
    if (!text) return;
    await ML.copyText(text);
    showToast('命令已复制到剪贴板');
  });
});

// ---- Export CSV ----
async function exportCsv() {
  const list = getVisibleModels();
  if (!list.length) {
    showToast('当前没有可导出的模型');
    return;
  }
  const rows = list.map((m) => {
    const meta = m.meta || {};
    const nm = noteFor(m);
    return {
      name: m.name,
      size: m.size,
      sizeText: formatSize(m.size),
      dateText: new Date(m.modified).toLocaleString('zh-CN'),
      path: m.path,
      architecture: meta.architecture || '',
      quantization: meta.quantization || '',
      contextLength: meta.contextLength || '',
      parameterCount: meta.parameterCount || '',
      tags: (nm.tags || []).join(' / '),
      note: nm.note || '',
    };
  });
  const result = await ML.exportCsv(rows);
  if (result.canceled) return;
  if (result.ok) showToast('清单已导出：' + result.path);
  else showToast('导出失败：' + (result.error || '未知错误'));
}

// ---- About dialog ----
async function openAbout() {
  try {
    const info = await ML.getAppInfo();
    el.aboutVersion.textContent = '版本 ' + info.version;
    el.aboutDetails.innerHTML = `
      Electron ${esc(info.electron)} · Node ${esc(info.node)} · Chromium ${esc(info.chrome)}<br />
      平台：${esc(info.platform)}<br />
      本地解析 GGUF 元数据，不上传任何数据
    `;
  } catch (err) {
    el.aboutVersion.textContent = '版本 1.2.0';
  }
  el.aboutModal.classList.remove('hidden');
}

// ---- Settings dialog ----
function renderSettingsFolders() {
  el.settingsFolders.innerHTML = '';
  if (!state.folders.length) {
    el.settingsFolders.innerHTML = '<div class="cmd-hint">尚未添加任何文件夹</div>';
    return;
  }
  state.folders.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'settings-folder-item';
    const name = f.split(/[\\/]/).filter(Boolean).pop() || f;
    item.innerHTML = `<span title="${esc(f)}">${esc(name)}</span><button data-index="${i}" title="移除">&times;</button>`;
    item.querySelector('button').addEventListener('click', async (e) => {
      state.folders.splice(Number(e.target.getAttribute('data-index')), 1);
      await ML.saveFolders(state.folders);
      renderFolders();
      renderSettingsFolders();
      await refreshModels();
    });
    el.settingsFolders.appendChild(item);
  });
}

async function openSettings() {
  renderSettingsFolders();
  renderSettingsGpus();
  renderBrandLegend();
  try {
    const settings = await ML.loadSettings();
    if (settings && settings.scanDepth) el.settingsDepth.value = String(settings.scanDepth);
    const ex = document.getElementById('settings-excludes');
    if (ex && settings && settings.scanExcludes) ex.value = settings.scanExcludes;
    const hasToken = await ML.hasSecret('hfToken');
    el.settingsHfToken.value = '';
    el.settingsTokenStatus.textContent = hasToken ? '状态：已保存 Token（留空并保存可清除）' : '状态：未设置';
    el.settingsProxy.value = settings.proxy || '';
    el.settingsConflict.value = settings.conflict || 'skip';
    el.settingsConcurrent.value = String(settings.concurrent || 2);
    maxConcurrent = settings.concurrent || 2;
    const theme = settings.theme || 'light';
    document.getElementById('settings-theme').value = theme;
    applyTheme(theme);
    const lang = settings.lang || 'zh';
    document.getElementById('settings-lang').value = lang;
    applyLanguage(lang);
    state.cols = settings.cols || state.cols;
    document.getElementById('col-arch').checked = state.cols.arch !== false;
    document.getElementById('col-quant').checked = state.cols.quant !== false;
    document.getElementById('col-ctx').checked = state.cols.ctx !== false;
    document.getElementById('col-params').checked = state.cols.params !== false;
  } catch (e) { /* keep default */ }
  el.settingsModal.classList.remove('hidden');
}

document.getElementById('settings-save-cols').addEventListener('click', async () => {
  const settings = await ML.loadSettings();
  settings.cols = {
    arch: document.getElementById('col-arch').checked,
    quant: document.getElementById('col-quant').checked,
    ctx: document.getElementById('col-ctx').checked,
    params: document.getElementById('col-params').checked,
  };
  state.cols = settings.cols;
  await ML.saveSettings(settings);
  renderModels();
  showToast('显示设置已保存');
});

document.getElementById('settings-save-network').addEventListener('click', async () => {
  const settings = await ML.loadSettings();
  settings.proxy = el.settingsProxy.value.trim();
  settings.conflict = el.settingsConflict.value;
  settings.concurrent = Number(el.settingsConcurrent.value);
  maxConcurrent = settings.concurrent;
  const ok = await ML.saveSettings(settings);
  pumpDownloadQueue();
  showToast(ok ? '网络设置已保存（重启后仍生效）' : '保存失败');
});

document.getElementById('settings-test-mirror').addEventListener('click', async () => {
  el.settingsMirrorResult.textContent = '测试中...';
  try {
    const [hf, mirror] = await Promise.all([
      ML.testMirrorSpeed('hf'),
      ML.testMirrorSpeed('mirror'),
    ]);
    const fmt = (r) => r.ok ? (r.ms + ' ms') : '不可用';
    const faster = (hf.ok && hf.ms <= mirror.ms) ? 'Hugging Face' : (mirror.ok ? '国内镜像' : '无可用源');
    el.settingsMirrorResult.textContent =
      'Hugging Face: ' + fmt(hf) + ' | 国内镜像: ' + fmt(mirror) + ' → 推荐：' + faster;
  } catch (e) {
    el.settingsMirrorResult.textContent = '测速失败: ' + e.message;
  }
});

document.getElementById('settings-save-token').addEventListener('click', async () => {
  const val = el.settingsHfToken.value.trim();
  const ok = await ML.setSecret('hfToken', val);
  if (ok) {
    el.settingsHfToken.value = '';
    el.settingsTokenStatus.textContent = val ? '状态：已保存（系统加密）' : '状态：已清除';
    showToast(val ? 'Token 已加密保存' : 'Token 已清除');
  } else {
    showToast('保存失败');
  }
});

el.settingsDepth.addEventListener('change', async () => {
  const depth = Number(el.settingsDepth.value);
  const ok = await ML.saveSettings({ scanDepth: depth });
  showToast(ok ? '扫描深度已保存，点刷新生效' : '保存失败');
});

const settingsExcludes = document.getElementById('settings-excludes');
if (settingsExcludes) settingsExcludes.addEventListener('change', async () => {
  const ok = await ML.saveSettings({ scanExcludes: settingsExcludes.value });
  showToast(ok ? '排除规则已保存，点刷新生效' : '保存失败');
});

const btnDiagnostics = document.getElementById('settings-diagnostics');
if (btnDiagnostics) btnDiagnostics.addEventListener('click', async () => {
  const box = document.getElementById('settings-data-result');
  box.textContent = '正在打包...';
  try {
    const r = await ML.exportDiagnostics();
    box.textContent = r.ok ? ('诊断包已保存到桌面：' + r.path) : ('失败：' + r.error);
  } catch (e) { box.textContent = '失败：' + e.message; }
});

const btnCleanEngines = document.getElementById('settings-clean-engines');
if (btnCleanEngines) btnCleanEngines.addEventListener('click', async () => {
  if (!window.confirm('只删除软件自己留下的旧引擎缓存，不影响当前引擎和模型文件。继续？')) return;
  const box = document.getElementById('settings-data-result');
  box.textContent = '清理中...';
  try {
    const r = await ML.cleanOldEngines();
    box.textContent = r.ok
      ? ('已清理 ' + r.removed.length + ' 处旧缓存，释放 ' + formatSize(r.freedBytes))
      : ('失败：' + r.error);
  } catch (e) { box.textContent = '失败：' + e.message; }
});

// Optional CUDA component pack (downloaded separately, main installer stays small).
async function refreshCudaPackStatus() {
  const box = document.getElementById('cuda-pack-status');
  if (!box || !ML.cudaPackStatus) return;
  try {
    const r = await ML.cudaPackStatus();
    if (!r.ok) { box.textContent = '状态检测失败：' + r.error; return; }
    const lines = [];
    if (r.installed) {
      lines.push('已安装 CUDA 组件包（' + formatSize(r.bytes) + '）：' + r.dir);
      if (r.hasRuntime === false) lines.push('注意：组件包缺少运行时 DLL，CUDA 可能无法启动');
    } else {
      lines.push('未安装 CUDA 组件包。当前使用本机已有后端或 Vulkan / CPU。');
    }
    if (r.driverVersion) lines.push('NVIDIA 驱动 ' + r.driverVersion + '（组件包要求 525+，建议 570+）');
    if (r.driverWarning) lines.push(r.driverWarning);
    box.textContent = lines.join('　');
  } catch (e) { box.textContent = '状态检测失败：' + e.message; }
}

const btnCudaDownload = document.getElementById('cuda-pack-download');
if (btnCudaDownload) btnCudaDownload.addEventListener('click', async () => {
  const box = document.getElementById('cuda-pack-result');
  box.textContent = '正在打开下载页面...';
  try {
    const r = await ML.cudaPackDownload();
    box.textContent = r.ok
      ? '已在浏览器打开组件包下载页（约 713 MB）。下载完成后点「导入 CUDA 组件包」选择该 zip。'
      : ('打开失败：' + (r.error || '未知错误'));
  } catch (e) { box.textContent = '打开失败：' + e.message; }
});

const btnCudaImport = document.getElementById('cuda-pack-import');
if (btnCudaImport) btnCudaImport.addEventListener('click', async () => {
  const box = document.getElementById('cuda-pack-result');
  box.textContent = '正在导入组件包...';
  try {
    const r = await ML.cudaPackImport();
    if (r.canceled) { box.textContent = '已取消'; return; }
    box.textContent = r.ok ? (r.message + '。' + r.dir) : ('失败：' + r.error);
  } catch (e) { box.textContent = '失败：' + e.message; }
  await refreshCudaPackStatus();
});

const btnCudaRemove = document.getElementById('cuda-pack-remove');
if (btnCudaRemove) btnCudaRemove.addEventListener('click', async () => {
  if (!window.confirm('卸载已安装的 CUDA 组件包？之后会回退到 Vulkan / CPU。')) return;
  const box = document.getElementById('cuda-pack-result');
  try {
    const r = await ML.cudaPackRemove();
    box.textContent = r.ok ? '已卸载 CUDA 组件包，重启软件后生效' : ('失败：' + r.error);
  } catch (e) { box.textContent = '失败：' + e.message; }
  await refreshCudaPackStatus();
});
refreshCudaPackStatus();

const btnFitOnly = document.getElementById('btn-fit-only');
if (btnFitOnly) btnFitOnly.addEventListener('click', () => {
  state.fitOnly = !state.fitOnly;
  btnFitOnly.classList.toggle('active', state.fitOnly);
  renderModels();
  showToast(state.fitOnly ? '只显示本机显存能跑的版本' : '显示全部版本');
});

document.getElementById('btn-export').addEventListener('click', exportCsv);

document.getElementById('btn-calc-sha').addEventListener('click', async () => {
  if (!state.currentModel) return;
  const btn = document.getElementById('btn-calc-sha');
  btn.textContent = '计算中...';
  btn.disabled = true;
  el.detailSha.textContent = '正在读取文件，请稍候...';
  try {
    const r = await ML.fileSha256(state.currentModel.path);
    if (r.ok) {
      el.detailSha.textContent = r.sha256;
      el.detailSha.setAttribute('data-cmd', r.sha256);
      showToast('SHA256 已算出，可点文字复制');
    } else {
      el.detailSha.textContent = '计算失败：' + (r.error || '未知错误');
    }
  } catch (err) {
    el.detailSha.textContent = '计算失败：' + err.message;
  } finally {
    btn.textContent = '计算 SHA256（大文件需几十秒）';
    btn.disabled = false;
  }
});

document.getElementById('btn-check-shards').addEventListener('click', async () => {
  const out = document.getElementById('detail-shards');
  if (!state.currentModel) return;
  out.textContent = '检查中...';
  try {
    const r = await ML.checkShards(state.currentModel.path);
    if (!r.applicable) {
      out.textContent = r.error ? ('检查失败：' + r.error) : '此文件不是分片格式（如 model-00001-of-00004.safetensors），无需检查。';
    } else if (r.ok) {
      out.textContent = '分片完整：共 ' + r.total + ' 片，全部存在。' + (r.hasIndex ? ' 已找到 index.json。' : ' 未找到 index.json。');
    } else {
      out.textContent = '分片缺失：应有 ' + r.total + ' 片，找到 ' + r.found + ' 片。缺失：' + r.missing.join(', ');
    }
  } catch (e) { out.textContent = '检查失败：' + e.message; }
});

el.detailSha.addEventListener('click', async () => {
  const text = el.detailSha.getAttribute('data-cmd');
  if (!text) return;
  await ML.copyText(text);
  showToast('SHA256 已复制');
});

// download UI bindings
document.getElementById('hf-search-btn').addEventListener('click', doSearch);
el.hfSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
document.getElementById('btn-pick-download-dir').addEventListener('click', async () => {
  const dir = await ML.pickDownloadDir();
  if (dir) {
    state.downloadDir = dir;
    el.downloadDirText.textContent = dir;
    el.downloadDirText.title = dir;
  }
});

el.aboutClose.addEventListener('click', () => el.aboutModal.classList.add('hidden'));
el.aboutModal.addEventListener('click', (e) => {
  if (e.target === el.aboutModal) el.aboutModal.classList.add('hidden');
});

// ---- Licenses dialog ----
const licensesModal = document.getElementById('licenses-modal');
const licensesContent = document.getElementById('licenses-content');

async function openLicenses() {
  el.aboutModal.classList.add('hidden');
  licensesModal.classList.remove('hidden');
  licensesContent.textContent = '加载中...';
  try {
    const r = await ML.getLicenses();
    if (r.ok) licensesContent.textContent = r.text;
    else licensesContent.textContent = '无法读取致谢文件：' + (r.error || '未知错误');
  } catch (err) {
    licensesContent.textContent = '加载失败：' + err.message;
  }
}

// ---- User guide dialog ----
const guideModal = document.getElementById('guide-modal');
const guideContent = document.getElementById('guide-content');

async function openGuide() {
  licensesModal.classList.add('hidden');
  el.aboutModal.classList.add('hidden');
  guideModal.classList.remove('hidden');
  guideContent.textContent = '加载中...';
  try {
    const r = await ML.getGuide();
    if (r.ok) guideContent.textContent = r.text;
    else guideContent.textContent = '无法读取使用指南：' + (r.error || '未知错误');
  } catch (err) {
    guideContent.textContent = '加载失败：' + err.message;
  }
}

document.getElementById('guide-close').addEventListener('click', () => guideModal.classList.add('hidden'));
guideModal.addEventListener('click', (e) => {
  if (e.target === guideModal) guideModal.classList.add('hidden');
});

document.getElementById('about-licenses').addEventListener('click', openLicenses);
document.getElementById('about-guide').addEventListener('click', openGuide);
document.getElementById('licenses-close').addEventListener('click', () => licensesModal.classList.add('hidden'));
licensesModal.addEventListener('click', (e) => {
  if (e.target === licensesModal) licensesModal.classList.add('hidden');
});
document.getElementById('license-open-electron').addEventListener('click', async () => {
  const ok = await ML.openLicenseFile('LICENSE.electron.txt');
  if (!ok) showToast('未找到 Electron 许可证文件');
});
document.getElementById('license-open-chromium').addEventListener('click', async () => {
  const ok = await ML.openLicenseFile('LICENSES.chromium.html');
  if (!ok) showToast('未找到 Chromium 许可证文件');
});
document.getElementById('license-open-notices').addEventListener('click', async () => {
  const ok = await ML.openLicenseFile('THIRD_PARTY_NOTICES.md');
  if (!ok) showToast('未找到完整致谢文件');
});
el.settingsClose.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
el.settingsModal.addEventListener('click', (e) => {
  if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden');
});
el.settingsAddFolder.addEventListener('click', async () => {
  const dir = await ML.pickDirectory();
  if (dir && !state.folders.includes(dir)) {
    state.folders.push(dir);
    await ML.saveFolders(state.folders);
    renderFolders();
    renderSettingsFolders();
    await refreshModels();
  }
});

el.settingsResetNotes.addEventListener('click', async () => {
  if (!window.confirm('确定清空所有标签和备注吗？此操作不可撤销（不会删除模型文件）。')) return;
  for (const p of Object.keys(state.notes)) {
    await ML.saveNote(p, { tags: [], note: '' });
  }
  state.notes = {};
  renderModels();
  showToast('标签和备注已清空');
});

// ---- Menu events from main process ----
ML.onMenu((evt) => {
  if (evt === 'menu-add-folder') addFolder();
  else if (evt === 'menu-download') {
    document.querySelector('.nav-item[data-view="download"]').click();
  }
  else if (evt === 'menu-refresh') refreshModels();
  else if (evt === 'menu-export') exportCsv();
  else if (evt === 'menu-settings') openSettings();
  else if (evt === 'menu-about') openAbout();
  else if (evt === 'menu-licenses') openLicenses();
  else if (evt === 'menu-guide') openGuide();
});

// ---- Featured model catalog (static, no server dependency) ----
// These are well-known GGUF repos; clicking one jumps straight to its detail page.
const FEATURED = [
  { label: 'Qwen2.5 7B', repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF' },
  { label: 'Qwen2.5 14B', repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF' },
  { label: 'Qwen2.5 3B', repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF' },
  { label: 'Gemma 3 4B', repo: 'ggml-org/gemma-3-4b-it-GGUF' },
  { label: 'DeepSeek R1 7B', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF' },
  { label: 'Llama 3.2 3B', repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF' },
  { label: 'Qwen2.5 Coder', repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' },
];
(function renderFeatured() {
  const box = document.getElementById('featured-chips');
  if (!box) return;
  FEATURED.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'secondary-btn';
    btn.textContent = item.label;
    btn.title = item.repo;
    btn.addEventListener('click', () => {
      openModelDetail({ id: item.repo, name: item.repo.split('/').pop(), author: item.repo.split('/')[0], source: 'mirror' });
    });
    box.appendChild(btn);
  });
})();

// ---- Model browse UI (LM-Studio style) ----
// Flow: type a name -> search -> click a result -> pick a quantization -> Download.
async function doSearch() {
  const q = el.hfSearchInput.value.trim();
  if (!q) { showToast('请输入模型名称'); return; }
  const source = el.hfSourceSelect.value;
  const typeFilter = document.getElementById('hf-type-select').value;
  // Try the chosen source first, then fall back to the others (mirror/HF are flaky in CN).
  const order = source === 'ms'
    ? ['ms', 'mirror', 'hf']
    : [source, ...['mirror', 'hf', 'ms'].filter((s) => s !== source)];
  el.hfHint.innerHTML = '<p>' + t('dl.searching') + '</p>';
  el.hfHint.classList.remove('hidden');
  el.hfResults.innerHTML = '';
  let lastErr = null;
  for (const src of order) {
    try {
      const r = await ML.hfSearch(q, src, typeFilter);
      if (!r.ok) throw new Error(r.error);
      state.hfModels = r.models || [];
      state.hfSelected = null;
      el.hfHint.classList.add('hidden');
      renderHfResults();
      // Gated model names must not be silently degraded to same-named
      // ModelScope repos — those are usually unrelated community uploads.
      if (r.gatedHint && src !== 'ms') {
        el.hfHint.innerHTML = '<h2>' + t('dl.noResult') + '</h2><p>' + esc(r.gatedHint) + '</p>';
        el.hfHint.classList.remove('hidden');
        return;
      }
      if (src !== source) {
        const label = src === 'mirror' ? '国内镜像' : (src === 'hf' ? 'Hugging Face' : 'ModelScope 魔搭');
        showToast('已自动切换「' + label + '」完成搜索');
      }
      if (!state.hfModels.length) {
        el.hfHint.innerHTML = '<h2>' + t('dl.noResult') + '</h2><p>' + t('dl.noResultHint') + '</p>';
        el.hfHint.classList.remove('hidden');
      }
      return;
    } catch (err) {
      lastErr = err;
      const label = src === 'mirror' ? '国内镜像' : (src === 'hf' ? 'Hugging Face' : 'ModelScope 魔搭');
      el.hfHint.innerHTML = '<p>' + t('dl.searching') + '（切换备用源 ' + label + '...）</p>';
    }
  }
  el.hfHint.innerHTML = '<h2>' + t('dl.searchFail') + '</h2><p>' + esc(lastErr && lastErr.message || '') + '</p><p style="margin-top:8px;color:var(--text-tertiary)">三个源都试过了。换个关键词，或者点上面的「热门推荐」直接进。</p>';
  el.hfHint.classList.remove('hidden');
}

function renderHfResults() {
  el.hfResults.innerHTML = '';
  if (!state.hfModels.length) return;
  state.hfModels.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'hf-card' + (state.hfSelected && state.hfSelected.id === m.id ? ' selected' : '');
    const fmtNum = (n) => n >= 10000 ? (n / 10000).toFixed(1) + 'w' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
    const params = guessParams(m.id);
    card.innerHTML = `
      <div class="hf-card-title">${esc(m.name || m.id)}</div>
      <div class="hf-card-meta">
        ${m.author ? `<span>${esc(m.author)}</span>` : ''}
        ${params ? `<span>${params}</span>` : ''}
        <span>下载 ${fmtNum(m.downloads)}</span>
        <span>喜欢 ${fmtNum(m.likes)}</span>
        ${m.gated ? '<span class="gated-tag">需 Token</span>' : ''}
      </div>
      <div class="hf-card-tags">${(m.tags || []).slice(0, 4).map((tg) => `<span class="card-tag">${esc(tg)}</span>`).join('')}</div>
    `;
    card.addEventListener('click', () => openModelDetail(m));
    el.hfResults.appendChild(card);
  });
}

// Guess a parameter count from the repo name, e.g. "Qwen2.5-7B" -> "7B"
function guessParams(name) {
  const m = String(name || '').match(/(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*[bB](?=$|[^a-zA-Z0-9])/);
  if (m) return m[1] + 'B 参数';
  return '';
}

// Open the right-hand detail panel for a model.
async function openModelDetail(m) {
  state.hfSelected = m;
  state.hfRevision = m.source === 'ms' ? 'master' : 'main';
  el.modelDetail.classList.remove('hidden');
  el.detailEmpty.classList.add('hidden');
  el.mdTitle.textContent = m.id;
  el.mdStats.innerHTML = '<span>加载中...</span>';
  el.mdDesc.textContent = '';
  el.mdTags.innerHTML = '';
  el.mdOptions.innerHTML = '<div class="cmd-hint">' + t('md.loading') + '</div>';
  el.mdReadme.innerHTML = '<div class="cmd-hint">加载中...</div>';
  renderHfResults();

  // One round trip: metadata + download options. README loads separately in
  // the background so a slow README endpoint never blocks the quant list.
  let res;
  try {
    res = await ML.modelPage(m.id, m.source, state.hfRevision);
  } catch (err) {
    el.mdStats.innerHTML = '<span style="color:var(--danger)">加载失败：' + esc(err.message) + '</span>';
    el.mdOptions.innerHTML = '<div class="cmd-hint" style="color:var(--danger)">加载失败：' + esc(err.message) + '</div>';
    el.mdReadme.innerHTML = '<div class="cmd-hint">加载失败</div>';
    ML.log('error', 'modelPage failed: ' + (err && err.message));
    return;
  }
  if (state.hfSelected && state.hfSelected.id !== m.id) return;

  const d = res.detail;
  if (d && d.gated && m.source !== 'ms') {
    let hasToken = false;
    try { hasToken = await ML.hasSecret('hfToken'); } catch (_) {}
    el.mdOptions.insertAdjacentHTML('afterbegin',
      '<div class="gated-banner">这是受限（gated）仓库：需要先在 Hugging Face 网页接受许可并保存 Token' +
      (hasToken ? '（已保存 Token）' : '（当前未保存 Token）') +
      '。软件不会自动换成魔搭上的同名仓库。</div>');
  }
  if (d) {
    const fmtNum = (n) => n >= 10000 ? (n / 10000).toFixed(1) + 'w' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
    const stats = [];
    stats.push('下载 ' + fmtNum(d.downloads || 0));
    stats.push('喜欢 ' + fmtNum(d.likes || 0));
    if (d.lastModified) stats.push('更新于 ' + new Date(d.lastModified).toLocaleDateString('zh-CN'));
    if (d.contextLength) stats.push('上下文 ' + Math.round(d.contextLength / 1024) + 'K');
    el.mdStats.innerHTML = stats.map((s) => '<span>' + esc(s) + '</span>').join('');
    el.mdDesc.textContent = d.description || '';
    const tags = [];
    if (d.architecture) tags.push(d.architecture);
    if (d.license) tags.push(d.license);
    if (d.baseModel) tags.push('base: ' + d.baseModel);
    (d.tags || []).slice(0, 8).forEach((tg) => tags.push(tg));
    el.mdTags.innerHTML = tags.map((tg) => '<span class="card-tag">' + esc(tg) + '</span>').join('');
  } else {
    el.mdStats.innerHTML = '<span style="color:var(--danger)">' + t('md.detailFail') + esc(res.detailError || '') + '</span>';
  }

  if (res.optionsError) {
    el.mdOptions.innerHTML = '<div class="cmd-hint" style="color:var(--danger)">' + t('md.optionsFail') + esc(res.optionsError) + '</div>';
  } else {
    renderDownloadOptions(m, res.options || [], res.otherFiles || []);
  }

  // README loads in the background (the raw endpoint can be slow on CN mirrors).
  ML.modelReadme(m.id, m.source, state.hfRevision).then((r) => {
    if (state.hfSelected && state.hfSelected.id !== m.id) return;
    if (!r.ok || !r.text) { el.mdReadme.innerHTML = '<div class="cmd-hint">' + t('md.noReadme') + '</div>'; return; }
    el.mdReadme.innerHTML = renderMarkdown(r.text);
  }).catch(() => {
    if (state.hfSelected && state.hfSelected.id !== m.id) return;
    el.mdReadme.innerHTML = '<div class="cmd-hint">' + t('md.readmeFail') + '</div>';
  });
}

function renderDownloadOptions(m, options, otherFiles) {
  el.mdOptions.innerHTML = '';
  if (!options.length && !otherFiles.length) {
    el.mdOptions.innerHTML = '<div class="cmd-hint">' + t('md.noFiles') + '</div>';
    return;
  }
  options.forEach((opt) => {
    const row = document.createElement('div');
    row.className = 'md-option';
    const fit = opt.totalSize ? fitBadgeHtml(assessFitLocal(opt.totalSize)) : '';
    row.innerHTML = `
      <div class="md-option-main">
        <div class="md-option-name">${esc(opt.label)} ${fit}</div>
        <div class="md-option-sub" title="${esc(opt.filePath)}">${esc(opt.fileName)}${opt.shardCount > 1 ? ' · ' + opt.shardCount + ' 个分片' : ''}</div>
      </div>
      <div class="md-option-size">${opt.totalSize ? formatSize(opt.totalSize) : '大小未知'}</div>
      <button class="primary-btn small-btn" data-i18n="dl.download">下载</button>
    `;
    row.querySelector('button').addEventListener('click', () => startOptionDownload(m, opt));
    el.mdOptions.appendChild(row);
  });
  if (otherFiles.length) {
    const head = document.createElement('div');
    head.className = 'md-section-title';
    head.style.marginTop = '12px';
    head.textContent = t('md.other') + ' (' + otherFiles.length + ')';
    el.mdOptions.appendChild(head);
    otherFiles.slice(0, 30).forEach((f) => {
      const row = document.createElement('div');
      row.className = 'md-option';
      row.innerHTML = `
        <div class="md-option-main">
          <div class="md-option-name">${esc(f.name)}</div>
          <div class="md-option-sub" title="${esc(f.path)}">${esc(f.path)}</div>
        </div>
        <div class="md-option-size">${f.size ? formatSize(f.size) : ''}</div>
        <button class="secondary-btn small-btn" data-i18n="dl.download">下载</button>
      `;
      row.querySelector('button').addEventListener('click', () => startOptionDownload(m, { files: [f], label: f.name, totalSize: f.size || 0 }));
      el.mdOptions.appendChild(row);
    });
  }
}

// Minimal markdown -> HTML for the README block.
function renderMarkdown(text) {
  const lines = String(text).split('\n');
  const out = [];
  let inCode = false;
  let inFrontMatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') { inFrontMatter = true; continue; }
    if (inFrontMatter) {
      if (line.trim() === '---') inFrontMatter = false;
      continue;
    }
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      out.push(inCode ? '<pre>' : '</pre>');
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push('<h' + h[1].length + '>' + esc(h[2]) + '</h' + h[1].length + '>'); continue; }
    if (!line.trim()) { out.push(''); continue; }
    out.push(esc(line));
  }
  return out.join('\n');
}

function ensureDownloadDir() {
  if (state.downloadDir) return Promise.resolve(state.downloadDir);
  return ML.pickDownloadDir().then((dir) => {
    if (dir) {
      state.downloadDir = dir;
      el.downloadDirText.textContent = dir;
      el.downloadDirText.title = dir;
    }
    return dir;
  });
}

// ---- Concurrent download scheduler (max N parallel) ----
const downloadQueue = [];        // pending { task, d }
let runningDownloads = 0;
let maxConcurrent = 2;           // configurable via settings

function pumpDownloadQueue() {
  while (runningDownloads < maxConcurrent && downloadQueue.length > 0) {
    const job = downloadQueue.shift();
    // Skip cancelled tasks (record removed, or status flipped to cancelled while queued)
    if (!state.downloads[job.task.id] || state.downloads[job.task.id].status === 'cancelled') continue;
    runningDownloads++;
    runDownload(job.task, job.d).finally(() => {
      runningDownloads--;
      pumpDownloadQueue();
    });
  }
}

function enqueueDownload(task, d) {
  downloadQueue.push({ task, d });
  renderDownloadQueue();
  pumpDownloadQueue();
}

async function runDownload(task, d) {
  renderDownloadQueue();
  showToast('开始下载：' + d.name);
  const result = task.url ? await ML.downloadUrl(task) : await ML.downloadStart(task);
  const cur = state.downloads[task.id];
  if (!cur) return;
  if (result.ok) {
    cur.status = 'done';
    cur.loaded = cur.total || cur.loaded;
    if (result.skipped) showToast('文件已存在，跳过：' + d.name);
    else showToast('下载完成：' + d.name);
    try { if (document.hidden && ML.notifyDownloadDone) ML.notifyDownloadDone(d.name); } catch (_) {}
    if (!state.folders.includes(task.destDir)) {
      state.folders.push(task.destDir);
      await ML.saveFolders(state.folders);
      renderFolders();
    }
    await refreshModels();
  } else if (result.cancelled) {
    cur.status = 'cancelled';
    showToast('已取消：' + d.name);
  } else {
    cur.status = 'error';
    cur.error = result.error;
    showToast('下载失败：' + (result.error || '未知错误'));
  }
  renderDownloadQueue();
}

// Start downloading one "download option" (a quantization, possibly split into shards).
async function startOptionDownload(model, opt) {
  const dir = await ensureDownloadDir();
  if (!dir) { showToast('请选择下载目录'); return; }
  const files = opt.files && opt.files.length ? opt.files : [opt.file].filter(Boolean);
  if (!files.length) { showToast('没有可下载的文件'); return; }
  const totalSize = opt.totalSize || files.reduce((s, f) => s + (f.size || 0), 0);
  // check disk space before starting (10% headroom)
  if (totalSize) {
    const space = await ML.checkDiskSpace(dir, totalSize * 1.1);
    if (space.ok && !space.enough) {
      showToast('磁盘空间不足，需要 ' + formatSize(totalSize) + '，可用 ' + formatSize(space.free));
      return;
    }
  }
  const id = 'dl-' + (++state.downloadSeq) + '-' + Date.now();
  const task = {
    id, repoId: model.id, files, destDir: dir,
    sourceKey: model.source, kind: 'repo', revision: state.hfRevision || undefined,
  };
  const displayName = (opt.label && opt.label !== '其它') ? opt.label + ' · ' + files[0].name : files[0].name;
  state.downloads[id] = {
    id, name: displayName, status: 'pending', loaded: 0, total: totalSize, speed: 0, task,
  };
  enqueueDownload(task, state.downloads[id]);
}

function renderDownloadQueue() {
  const tasks = Object.values(state.downloads);
  const active = tasks.filter((d) => d.status === 'downloading' || d.status === 'pending' || d.status === 'paused').length;
  if (ML.reportActiveDownloads) ML.reportActiveDownloads(active);
  persistDownloads();
  el.downloadCount.textContent = tasks.length;
  const statsEl = document.getElementById('download-stats');
  if (statsEl) {
    const done = tasks.filter(d => d.status === 'done').length;
    const failed = tasks.filter(d => d.status === 'error' || d.status === 'cancelled' || d.status === 'stalled').length;
    statsEl.textContent = '全部 ' + tasks.length + ' · 进行中 ' + active + ' · 已完成 ' + done + ' · 失败 ' + failed;
  }
  if (!tasks.length) {
    el.downloadQueue.innerHTML = '<div class="cmd-hint">暂无下载任务</div>';
    return;
  }
  el.downloadQueue.innerHTML = '';
  tasks.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'dl-item ' + (d.status === 'done' ? 'done' : d.status === 'error' ? 'error' : '');
    const pct = d.total > 0 ? Math.min(100, Math.round(d.loaded / d.total * 100)) : 0;
    let statusText = d.status;
    if (d.status === 'downloading') {
      statusText = `${formatSize(d.loaded)} / ${d.total ? formatSize(d.total) : '?'}  ${d.speed ? formatSize(d.speed) + '/s' : ''}`;
    } else if (d.status === 'done') statusText = '完成 · ' + formatSize(d.loaded);
    else if (d.status === 'error') statusText = '失败：' + (d.error || '未知错误');
    else if (d.status === 'pending') statusText = '准备中...';
    else if (d.status === 'cancelled') statusText = '已取消';
    item.innerHTML = `
      <div class="dl-item-name" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="dl-item-status">${esc(statusText)}</div>
      <div class="dl-progress-bg"><div class="dl-progress-bar" style="width:${pct}%"></div></div>
      <div class="dl-item-actions">
        ${(d.status === 'downloading' || d.status === 'pending') ? '<button data-act="pause">暂停</button><button data-act="cancel">取消</button>' : ''}
        ${d.status === 'paused' ? '<button data-act="resume">继续</button><button data-act="cancel">取消</button>' : ''}
        ${(d.status === 'error' || d.status === 'cancelled') ? '<button data-act="retry">重试</button>' : ''}
      </div>
    `;
    item.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.getAttribute('data-act');
        if (act === 'cancel') {
          await ML.downloadCancel(d.id);
          // Remove from queue and UI regardless of whether a live stream existed,
          // so a queued-but-not-started task cannot leave a stale active count.
          const qi = downloadQueue.findIndex(j => j.task && j.task.id === d.id);
          if (qi !== -1) downloadQueue.splice(qi, 1);
          d.status = 'cancelled';
          renderDownloadQueue();
        }
        else if (act === 'pause') { await ML.downloadPause(d.id); d.status = 'paused'; renderDownloadQueue(); }
        else if (act === 'resume') {
          if (d.restored || !d.task) {
            // Restored task has no live main-process controller — start a fresh download (resumes from .part)
            const newId = (d.task?.kind === 'url' ? 'url-' : 'dl-') + (++state.downloadSeq) + '-' + Date.now();
            const newTask = { ...d.task, id: newId };
            const nd = { id: newId, name: d.name, status: 'pending', loaded: d.loaded || 0, total: d.total, speed: 0, task: newTask };
            state.downloads[newId] = nd;
            delete state.downloads[d.id];
            enqueueDownload(newTask, nd);
          } else {
            await ML.downloadResume(d.id); d.status = 'downloading'; renderDownloadQueue();
          }
        }
        else if (act === 'retry') {
          const task = d.task;
          if (!task) { showToast('无法重试：缺少任务信息'); return; }
          // fresh id so progress events don't collide with the old task
          const newId = (task.kind === 'url' ? 'url-' : 'dl-') + (++state.downloadSeq) + '-' + Date.now();
          const newTask = { ...task, id: newId };
          const nd = {
            id: newId, name: d.name, status: 'pending', loaded: 0,
            total: d.total, speed: 0, error: null, task: newTask,
          };
          state.downloads[newId] = nd;
          delete state.downloads[d.id];
          enqueueDownload(newTask, nd);
        }
      });
    });
    el.downloadQueue.appendChild(item);
  });
}

ML.onDownloadProgress((p) => {
  const d = state.downloads[p.id];
  if (!d) return;
  if (d.status === 'paused' && p.status === 'downloading') return; // keep paused UI state
  d.status = p.status;
  d.loaded = p.loaded || 0;
  d.total = p.total || d.total;
  d.speed = p.speed || 0;
  renderDownloadQueue();
});

// ---- Init ----
(async () => {
  applyTheme('light'); // default until saved theme loads
  state.folders = await ML.loadFolders();
  state.notes = await ML.loadNotes();
  // GPU detection spawns nvidia-smi + PowerShell CIM + WMI (hundreds of ms).
  // Do NOT block first paint on it: render the UI immediately, fill GPUs in the background.
  state.gpus = [];
  state.brands = await ML.getBrands();
  renderGpuInfo();
  ML.getGpus().then((gpus) => {
    state.gpus = gpus || [];
    renderGpuInfo();
    renderSettingsGpus();
    renderModels(); // re-evaluate VRAM fit badges once GPUs arrive
  }).catch(() => {});
  const btnRefreshGpu = document.getElementById('btn-refresh-gpu');
  if (btnRefreshGpu) {
    btnRefreshGpu.addEventListener('click', async () => {
      btnRefreshGpu.textContent = '检测中';
      state.gpus = await ML.refreshGpus();
      renderGpuInfo();
      renderSettingsGpus();
      renderModels();
      btnRefreshGpu.textContent = '刷新';
      showToast('已检测到 ' + state.gpus.length + ' 张显卡');
    });
  }
  renderSettingsGpus();
  renderFolders();
  await refreshModels();
  // Restore unfinished downloads from previous session (as paused, user resumes manually)
  try {
    const saved = await ML.loadDownloads();
    if (saved && saved.length) {
      for (const t of saved) {
        state.downloads[t.id] = {
          id: t.id, name: t.name, status: 'paused', loaded: t.loaded || 0,
          total: t.total || 0, speed: 0, task: t.task, error: t.error || '',
          restored: true,
        };
        state.downloadSeq = Math.max(state.downloadSeq, parseInt(String(t.id).match(/\d+/)?.[0] || '0', 10));
      }
    }
  } catch (e) { /* ignore */ }
  renderDownloadQueue();
})();

// Debounced persistence of unfinished download tasks
let saveDownloadsTimer = null;
function persistDownloads() {
  if (saveDownloadsTimer) clearTimeout(saveDownloadsTimer);
  saveDownloadsTimer = setTimeout(() => {
    try { ML.saveDownloads(Object.values(state.downloads)); } catch (e) { /* ignore */ }
  }, 500);
}

// ============================================================
// AI 对话模块 —— 以「模型」为中心
//
// 核心路径：选一个本机 GGUF → 内置引擎直接起 → 开聊。
// 软件自带 llama.cpp 运行时，用户不需要装 Ollama / LM Studio。
// 外部后端（Ollama / LM Studio / 外部 llama.cpp）作为可选增强。
// 全程只连 127.0.0.1。
// ============================================================
const chatState = {
  backends: [],       // 外部后端
  backend: null,      // 选中的外部后端 key；null = 用内置引擎
  models: [],         // 外部后端的模型列表
  model: null,        // 当前模型 key（内置引擎时为模型文件路径）
  localModels: [],    // 本机 GGUF（内置引擎可直接用）
  importedModels: [], // 用户从任意路径导入的 GGUF（不依赖已添加文件夹）
  engineReady: false, // 内置引擎是否可用
  engineRunning: false,
  history: [],        // { role, content } — always points at the active session
  streaming: false,
  pending: false,
  // --- work assistant state ---
  sessions: [],       // [{ id, title, createdAt, updatedAt, messages }]
  activeSessionId: null,
  contextFiles: [],   // [{ name, path, content, truncated }] — injected each turn
  mode: 'general',
  saveTimer: null,
};

// Short, concrete system prompts. Small local models follow short instructions
// far better than long ones — these are deliberately terse.
const WORK_MODES = {
  general: '',
  summary: '你是文档分析助手。严格依据用户提供的资料作答，不要编造。用简洁条目列出要点，最后给出一句结论。',
  writing: '你是中文写作编辑。保留原意，使表达更清晰、简洁、专业。先给出改写后的完整版本，再用两三句说明改动。',
  translate: '你是专业翻译。忠实原文、术语准确、表达自然。只输出译文，不解释。',
  code: '你是资深程序员。只指出真实存在的问题（bug、边界、安全、性能），按严重程度排序，并给出修改后的关键代码。不要空泛建议。',
  data: '你是数据分析助手。只依据用户提供的数据回答，说明计算口径；数据不足时明确说无法判断，绝不编造数字。',
};

// Keep a clean copy of the welcome screen so "new chat" can restore it.
let welcomeTemplate = null;
try {
  const w = document.querySelector('#chat-messages .chat-welcome');
  if (w) welcomeTemplate = w.cloneNode(true);
} catch (_) { /* ignore */ }

function currentSession() {
  return chatState.sessions.find((s) => s.id === chatState.activeSessionId) || null;
}

function createSession() {
  const s = {
    id: 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    title: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  chatState.sessions.unshift(s);
  chatState.activeSessionId = s.id;
  chatState.history = s.messages;
  return s;
}

function syncCurrentSession() {
  const s = currentSession();
  if (!s) return;
  s.messages = chatState.history;
  if (!s.title) {
    const first = chatState.history.find((m) => m.role === 'user');
    s.title = first ? first.content.replace(/\s+/g, ' ').slice(0, 24) : (t('chat.new') || '新对话');
  }
  s.updatedAt = Date.now();
}

function persistSessions(immediate) {
  syncCurrentSession();
  const run = async () => {
    try {
      await ML.saveChatSessions({ activeId: chatState.activeSessionId, sessions: chatState.sessions });
    } catch (_) { /* disk write failure must never break chat */ }
  };
  if (immediate) return run();
  if (chatState.saveTimer) clearTimeout(chatState.saveTimer);
  chatState.saveTimer = setTimeout(run, 600);
}

function cloneWelcome() {
  if (!welcomeTemplate) return null;
  const node = welcomeTemplate.cloneNode(true);
  node.querySelectorAll('[data-i18n]').forEach((x) => {
    const v = t(x.getAttribute('data-i18n'));
    if (v) x.textContent = v;
  });
  return node;
}

function renderHistoryMessages() {
  if (!el.chatMessages) return;
  el.chatMessages.innerHTML = '';
  if (!chatState.history.length) {
    const w = cloneWelcome();
    if (w) el.chatMessages.appendChild(w);
    return;
  }
  chatState.history.forEach((m) => appendChatMessage(m.role, m.content));
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function renderChatSessions() {
  const box = document.getElementById('chat-sessions');
  if (!box) return;
  box.innerHTML = '';
  const sorted = chatState.sessions
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 12);
  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-session-empty';
    empty.textContent = t('chat.sessionEmpty');
    box.appendChild(empty);
    return;
  }
  sorted.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'chat-session' + (s.id === chatState.activeSessionId ? ' active' : '');

    const title = document.createElement('button');
    title.className = 'chat-session-title';
    title.textContent = s.title || (t('chat.new') || '新对话');
    title.title = title.textContent;
    title.addEventListener('click', () => switchSession(s.id));

    const del = document.createElement('button');
    del.className = 'chat-session-del';
    del.textContent = '×';
    del.title = t('chat.sessionDeleted');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });

    row.appendChild(title);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function switchSession(id) {
  if (chatState.streaming) { showToast(t('chat.busy')); return; }
  if (id === chatState.activeSessionId) return;
  persistSessions();
  const s = chatState.sessions.find((x) => x.id === id);
  if (!s) return;
  chatState.activeSessionId = id;
  chatState.history = Array.isArray(s.messages) ? s.messages : [];
  // Files belong to a task, not to the whole app — never leak them across chats.
  chatState.contextFiles = [];
  renderContextBar();
  renderChatSessions();
  renderHistoryMessages();
  persistSessions(true);
}

function deleteSession(id) {
  chatState.sessions = chatState.sessions.filter((s) => s.id !== id);
  if (chatState.activeSessionId === id) {
    if (!chatState.sessions.length) createSession();
    else {
      chatState.activeSessionId = chatState.sessions[0].id;
      chatState.history = chatState.sessions[0].messages || [];
      chatState.contextFiles = [];
      renderContextBar();
      renderHistoryMessages();
    }
  }
  renderChatSessions();
  persistSessions(true);
  showToast(t('chat.sessionDeleted'));
}

// System context assembled from work mode + attached files. It is injected as
// a temporary first message, so it never pollutes the saved chat history.
function buildWorkContext(searchEnabled) {
  const parts = [];
  const modeSelect = document.getElementById('chat-mode');
  const mode = (modeSelect && modeSelect.value) || chatState.mode || 'general';
  chatState.mode = mode;
  const modePrompt = WORK_MODES[mode];
  if (modePrompt) parts.push(modePrompt);

  // Tool-use protocol. The local model writes a marker, the app executes it,
  // feeds the real result back, and the model continues. No fake claims.
  const tools = [
    '你能调用工具。需要实时资料或要操作电脑时，在回答里只写下面的标记，系统会自动执行并把真实结果返回给你，然后你依据结果继续回答。禁止编造执行结果，禁止说"已执行"除非收到返回的工具结果。',
    '每次最多调用 2 个工具。标记必须单独一行，不要放进代码块。',
  ];
  if (searchEnabled) {
    tools.push('[[SEARCH:搜索词]] 联网搜索实时资料。涉及新闻、价格、显卡/手机规格、天气、软件版本等时效性问题时必须使用，不能凭记忆回答。搜索词里只能放通用的公开查询关键词，严禁把用户文件、剪贴板、本地路径或任何隐私内容写进搜索词——这些内容会通过搜索引擎发到外网。');
  } else {
    tools.push('用户未开启联网，不能搜索；遇到时效性内容就明确说不知道。');
  }
  tools.push(
    '[[ACTION:open_app|notepad]] 打开应用（notepad/calc/explorer/edge/chrome/code/settings/taskmgr）',
    '[[ACTION:open_url|https://...]] 打开网页；[[ACTION:open_path|完整路径]] 打开文件或文件夹',
    '[[ACTION:list_dir|路径]] 列出目录文件（路径留空表示用户目录）',
    '[[ACTION:read_file|完整路径]] 读取文本文件内容；[[ACTION:clipboard_write|内容]] 写入剪贴板',
    '[[ACTION:system_info]] 查看电脑配置',
    '[[SCRIPT:PowerShell脚本]] 运行脚本操作电脑。执行前会弹窗让用户确认，用 Write-Output 输出结果。示例：[[SCRIPT:Get-ChildItem $env:USERPROFILE\\Desktop | Select-Object -First 20 Name]]',
    '[[ACTION:download_software|7zip]] 下载常用软件（7zip/vscode/chrome/firefox/vlc/notepadpp/git/python/ollama/etcher/audacity/mailmaster）'
  );
  parts.push(tools.join('\n'));
  if (chatState.contextFiles.length) {
    const docs = chatState.contextFiles
      .map((f) => '【文件：' + f.name + '】\n' + f.content + (f.truncated ? '\n（内容已截断，只能看到前一部分）' : ''))
      .join('\n\n');
    parts.push('以下是用户提供的资料。回答必须优先依据这些资料，不要凭空编造；资料里没有的内容要明确说明。\n\n' + docs);
  }
  return parts.length ? parts.join('\n\n') : null;
}

function renderContextBar() {
  const bar = document.getElementById('chat-context-bar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!chatState.contextFiles.length) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  const label = document.createElement('span');
  label.className = 'ctx-label';
  label.textContent = t('chat.contextLabel');
  bar.appendChild(label);

  chatState.contextFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'ctx-chip';
    chip.title = f.path || f.name;
    chip.textContent = f.name;
    const x = document.createElement('button');
    x.className = 'ctx-chip-x';
    x.textContent = '×';
    x.title = t('chat.clearContext');
    x.addEventListener('click', () => {
      chatState.contextFiles.splice(i, 1);
      renderContextBar();
    });
    chip.appendChild(x);
    bar.appendChild(chip);
  });

  const clear = document.createElement('button');
  clear.className = 'ctx-clear';
  clear.textContent = t('chat.clearContext');
  clear.addEventListener('click', () => {
    chatState.contextFiles = [];
    renderContextBar();
  });
  bar.appendChild(clear);
}

async function ingestContextPaths(paths) {
  if (!paths || !paths.length || !ML.readContextFiles) return;
  const r = await ML.readContextFiles(paths);
  if (!r || !r.ok) return;
  let added = 0;
  let failed = 0;
  r.files.forEach((f) => {
    if (f.error || !f.content) { failed++; return; }
    chatState.contextFiles = chatState.contextFiles.filter((x) => x.path !== f.path);
    chatState.contextFiles.push(f);
    added++;
  });
  renderContextBar();
  showToast(t('chat.filesAdded') + added + (failed ? '，' + failed + t('chat.fileErrors') : ''));
}

async function attachContextFiles() {
  if (!ML.pickContextFiles || !ML.readContextFiles) {
    showToast(t('chat.importFail'));
    return;
  }
  const picked = await ML.pickContextFiles();
  if (!picked || !picked.ok || !picked.files || !picked.files.length) return;
  await ingestContextPaths(picked.files.map((f) => f.path));
}

async function exportChat() {
  if (!chatState.history.length) { showToast(t('chat.sessionEmpty')); return; }
  syncCurrentSession();
  const md = [
    '# ModelLodge ' + (t('chat.title') || 'Chat'),
    '',
    t('chat.export') + ': ' + new Date().toLocaleString(),
    '',
    ...chatState.history.map((m) =>
      '## ' + (m.role === 'user' ? (t('chat.user') || '我') : (t('chat.assistant') || 'AI')) + '\n\n' + m.content
    ),
  ].join('\n\n');
  try {
    const r = await ML.exportChatMd(md, 'ModelLodge-' + new Date().toISOString().slice(0, 10) + '.md');
    if (r && r.ok) showToast(t('chat.exported') + '：' + r.path);
  } catch (e) { showToast(t('chat.error') + e.message); }
}

// Jump into the chat with a ready-to-send prompt. Search examples also turn
// on the web tool, so the model is allowed to decide when to search.
function goToChatWithPrompt(prompt, enableWeb) {
  const nav = document.querySelector('.nav-item[data-view="chat"]');
  if (nav) nav.click();
  if (enableWeb) {
    const toggle = document.getElementById('chat-web-toggle');
    if (toggle) toggle.checked = true;
  }
  if (el.chatInput) {
    el.chatInput.value = prompt;
    el.chatInput.focus();
  }
}

function applyWelcomePrompt(action) {
  if (action === 'tools-doc') { goToTools('tool-docs'); return; }
  if (action === 'tools-pc') {
    goToChatWithPrompt('列出我桌面上的文件，按修改时间排序', false);
    return;
  }
  if (action === 'tools-search') {
    goToChatWithPrompt('2026 显卡天梯图，50 系和 40 系怎么选', true);
    return;
  }
  if (action === 'tools-download') { goToTools('tool-software'); return; }
  if (action === 'import') { importGgufFiles(); return; }
  if (action === 'download') {
    const nav = document.querySelector('.nav-item[data-view="download"]');
    if (nav) nav.click();
    return;
  }
  if (action === 'attach') {
    const preset = t('wc.attachPrompt');
    el.chatInput.value = preset;
    attachContextFiles();
    el.chatInput.focus();
    return;
  }
  const presets = {
    summary: ['summary', 'wc.summaryPrompt'],
    translate: ['translate', 'wc.translatePrompt'],
    code: ['code', 'wc.codePrompt'],
  };
  const hit = presets[action];
  if (!hit) return;
  const modeSelect = document.getElementById('chat-mode');
  if (modeSelect) { modeSelect.value = hit[0]; chatState.mode = hit[0]; }
  el.chatInput.value = t(hit[1]);
  el.chatInput.focus();
}

// Restore imported GGUF files and chat sessions from previous runs.
// Runs after chatState exists, before the first model selector render.
(async () => {
  if (ML.loadImportedModels) {
    try {
      const saved = await ML.loadImportedModels();
      if (Array.isArray(saved) && saved.length) {
        chatState.importedModels = saved;
        renderChatModelSelect();
        renderLocalModelLauncher();
      }
    } catch (e) { /* ignore */ }
  }
  if (ML.loadChatSessions) {
    try {
      const r = await ML.loadChatSessions();
      if (r && r.ok && Array.isArray(r.sessions) && r.sessions.length) {
        chatState.sessions = r.sessions;
        const active = r.sessions.find((s) => s.id === r.activeId) || r.sessions[0];
        chatState.activeSessionId = active.id;
        chatState.history = Array.isArray(active.messages) ? active.messages : [];
      }
    } catch (e) { /* ignore */ }
  }
  if (!chatState.activeSessionId) createSession();
  renderChatSessions();
  renderContextBar();
  if (chatState.history.length) renderHistoryMessages();
})();

// ---------- 内置引擎 ----------

async function refreshEngineStatus() {
  try {
    const r = await ML.engineDetect();
    if (!r.ok) return;
    chatState.engineReady = !!r.engine.bundled || !!r.engine.cuda || r.engine.externalCount > 0;
    chatState.engineRunning = !!r.status.running;
    chatState.engineVulkan = !!r.engine.vulkan;
    chatState.engineInfo = r.engine;
    chatState.runningBackend = r.status.backend || null;

    // Conservative context default by VRAM — only when the user never touched it.
    if (el.chatCtx && !el.chatCtx.dataset.touched && ML.engineSuggest) {
      const g = discreteGpu() || state.gpus[0];
      let freeMB = 0;
      try {
        const vu = await ML.vramUsage();
        if (vu && vu.ok && vu.gpus && vu.gpus[0]) freeMB = vu.gpus[0].freeMB || 0;
      } catch (_) { /* live reading is optional */ }
      const s = await ML.engineSuggest(0, g ? g.vramMB : 0, freeMB);
      if (s && s.ok && s.ctx && [...el.chatCtx.options].some((o) => o.value === String(s.ctx))) {
        el.chatCtx.value = String(s.ctx);
      }
    }
    // N cards are much faster on CUDA than Vulkan. Tell the truth in the UI.
    if (el.chatCudaHint) {
      const nvidia = !!r.engine.nvidia;
      const usingVulkan = chatState.runningBackend === 'vulkan';
      const noCuda = nvidia && !(r.engine.cudaCount > 0);
      const show = nvidia && (usingVulkan || noCuda);
      el.chatCudaHint.classList.toggle('hidden', !show);
      if (show) {
        el.chatCudaHint.textContent = noCuda
          ? '你的 NVIDIA 显卡未检测到 CUDA 后端，当前只能走 Vulkan —— 通常不如 CUDA 快。'
          : '当前引擎走 Vulkan；NVIDIA 显卡用 CUDA 通常更快，可在「加速后端」里切换。';
      }
    }
  } catch (e) { /* ignore */ }
}

function discreteGpu() {
  return (state.gpus || []).find((g) => !g.integrated) || null;
}

// Live dedicated VRAM meter. Shared-memory spills show up as "free" collapsing.
let vramTimer = null;
async function refreshVram() {
  if (!ML.vramUsage || !el.chatVram) return;
  try {
    const r = await ML.vramUsage();
    const g = r.gpus && r.gpus[0];
    if (!g) { el.chatVram.classList.add('hidden'); return; }
    el.chatVram.classList.remove('hidden');
    const pct = Math.max(0, Math.min(100, Math.round(g.usedMB / g.totalMB * 100)));
    el.chatVramText.textContent = (g.usedMB / 1024).toFixed(1) + ' / ' + (g.totalMB / 1024).toFixed(1) + ' GB';
    el.chatVramFill.style.width = pct + '%';
    const warn = pct >= 85 || g.freeMB < 512;
    el.chatVramFill.classList.toggle('warn', warn);
    el.chatVramWarn.classList.toggle('hidden', !warn);
  } catch (e) { /* ignore */ }
}
if (el.chatCtx) el.chatCtx.addEventListener('change', () => { el.chatCtx.dataset.touched = '1'; });

// 列出本机可直接对话的 GGUF 模型
function collectLocalModels() {
  const fromLibrary = (state.models || []).filter((m) => /\.gguf$/i.test(m.path || m.name || ''));
  // Merge library GGUFs with files the user imported from arbitrary paths.
  // De-duplicate by full path.
  const seen = new Set();
  const list = [];
  for (const m of [...fromLibrary, ...(chatState.importedModels || [])]) {
    const p = m.path || '';
    if (!p || seen.has(p) || !/\.gguf$/i.test(p)) continue;
    seen.add(p);
    list.push(m);
  }
  chatState.localModels = list;
  return list;
}

// Import GGUF files from any location on disk — no need to add a folder first.
async function importGgufFiles() {
  if (!ML.pickModelFiles) { showToast(t('chat.importFail')); return; }
  const files = await ML.pickModelFiles();
  if (!files || !files.length) return;
  let added = 0;
  for (const f of files) {
    if (!chatState.importedModels.some((m) => m.path === f.path)) {
      chatState.importedModels.push({ path: f.path, name: f.name, size: f.size || 0, type: 'GGUF' });
      added++;
    }
  }
  if (added && ML.saveImportedModels) {
    try { await ML.saveImportedModels(chatState.importedModels); } catch (e) { /* ignore */ }
  }
  renderChatModelSelect();
  renderLocalModelLauncher();
  if (added) showToast(t('chat.imported') + added);
}

function renderLocalModelLauncher() {
  const box = document.getElementById('chat-local-models');
  if (!box) return;
  box.innerHTML = '';
  const local = collectLocalModels();
  if (!local.length) return;   // empty state is covered by chatStatus
  const title = document.createElement('div');
  title.className = 'chat-side-title';
  title.style.marginTop = '8px';
  title.textContent = t('chat.localTitle');
  box.appendChild(title);
  const list = document.createElement('div');
  list.className = 'chat-local-list';
  local.slice(0, 12).forEach((m) => {
    const btn = document.createElement('button');
    btn.className = 'chat-local-model';
    btn.title = m.path;
    btn.textContent = m.name;
    btn.addEventListener('click', async () => {
      if (chatState.streaming) { showToast(t('chat.busy')); return; }
      const ok = await launchEngineWith(m);
      if (ok) {
        chatState.backend = null;      // 用内置引擎
        chatState.model = m.path;
        el.chatModelSelect.value = m.path;
        renderChatModelSelect();
      }
    });
    list.appendChild(btn);
  });
  box.appendChild(list);
}

// 启动内置引擎加载指定模型
// Resolve engine settings for this model: auto -ngl from VRAM, adaptive ctx,
// and the user's backend preference (auto | cuda | vulkan | cpu).
async function runtimeOptsFor(model) {
  const gpu = discreteGpu() || state.gpus[0];
  let ctx = Number(el.chatCtx.value) || 4096;
  let gpuLayers = 0;
  // Use the CURRENT free VRAM, not the card's nominal size: another app may
  // already be holding several GB, which is exactly what causes lazy OOM.
  let freeMB = 0;
  try {
    const vu = await ML.vramUsage();
    if (vu && vu.ok && vu.gpus && vu.gpus[0]) freeMB = vu.gpus[0].freeMB || 0;
  } catch (_) { /* fall back to total VRAM */ }
  if (ML.engineSuggest) {
    try {
      const sc = await ML.engineSuggest(0, gpu ? gpu.vramMB : 0, freeMB);
      if (sc && sc.ctx && el.chatCtx && !el.chatCtx.dataset.touched
        && [...el.chatCtx.options].some((o) => o.value === String(sc.ctx))) ctx = sc.ctx;
    } catch (_) {}
  }
  if (el.chatGpu && el.chatGpu.checked) {
    const choice = el.chatNgl ? el.chatNgl.value : 'auto';
    if (choice === 'auto') {
      let s = null;
      try { s = await ML.engineSuggest(model.size || 0, gpu ? gpu.vramMB : 0, freeMB); } catch (_) {}
      gpuLayers = s && s.gpuLayers != null ? s.gpuLayers : 50;
    } else {
      gpuLayers = Number(choice) || 0;
    }
  }
  return {
    ctx,
    gpuLayers,
    backendPreference: el.chatBackendPref ? el.chatBackendPref.value : 'auto',
    timeout: 300000,
  };
}

// Turn a raw CUDA OOM from llama-server into an actionable Chinese message.
function friendlyEngineError(err) {
  const raw = String((err && err.message) || err || '');
  if (/cudaMalloc failed|out of memory|failed to allocate CUDA|failed to allocate buffer/i.test(raw)) {
    return t('chat.error') + '显存不足：GPU 加载模型时分配失败。软件已自动逐级降低卸载层数与上下文重试；若仍失败，请把「GPU 卸载层数」调低或切到 CPU / Vulkan，并关闭其他占用显存的程序。';
  }
  return t('chat.error') + raw;
}

async function launchEngineWith(model) {
  const prevLabel = el.chatStatus.textContent;
  el.chatStatus.textContent = t('chat.loadingModel');
  showToast(t('chat.loadingModel'));
  try {
    const opts = await runtimeOptsFor(model);
    const r = await ML.engineStart(model.path, opts);
    chatState.runningBackend = r.backend || null;
    if (!r.ok) {
      // GPU offload can fail on odd drivers — retry on CPU rather than give up.
      if (el.chatGpu && el.chatGpu.checked) {
        showToast(t('chat.gpuFallback'));
        el.chatGpu.checked = false;
        const cpu = await ML.engineStart(model.path, {
          ctx: opts.ctx, gpuLayers: 0, backendPreference: 'cpu', timeout: 300000,
        });
        if (cpu.ok) {
          chatState.engineRunning = true;
          el.chatStatus.textContent = t('chat.engineReady') + (model.name || '');
          return true;
        }
      }
      const msg = r.error ? friendlyEngineError({ message: r.error }) : t('chat.startFail');
      el.chatStatus.textContent = msg;
      showToast(msg);
      chatState.engineRunning = false;
      return false;
    }
    chatState.engineRunning = true;
    const tag = r.backend ? ' [' + String(r.backend).toUpperCase() + ' · ' + (r.gpuLayers || 0) + ' 层]' : '';
    const note = r.message ? ' · ' + r.message : '';
    el.chatStatus.textContent = t('chat.engineReady') + (model.name || '') + tag + note;
    showToast(t('chat.engineReady') + (model.name || '') + tag + note);
    refreshVram();
    return true;
  } catch (e) {
    el.chatStatus.textContent = t('chat.startFail') + e.message;
    showToast(t('chat.startFail') + e.message);
    return false;
  } finally {
    if (!chatState.engineRunning) el.chatStatus.textContent = prevLabel;
  }
}

// ---------- 初始化 ----------

async function initChatView() {
  await refreshEngineStatus();
  await refreshVram();
  if (vramTimer) clearInterval(vramTimer);
  vramTimer = setInterval(() => {
    if (state.view === 'chat' && !document.getElementById('chat-view').classList.contains('hidden')) refreshVram();
  }, 3000);
  renderChatModelSelect();
  await refreshChatBackends();
  renderChatModelSelect();
  // Tell the user what state the engine is in.
  if (chatState.engineRunning) {
    el.chatStatus.textContent = t('chat.engineReady') + (chatState.localModels.find((m) => m.path === chatState.model)?.name || '');
  } else if (chatState.engineReady) {
    const n = chatState.localModels.length;
    el.chatStatus.textContent = n
      ? t('chat.pickModel') + n
      : t('chat.noLocal');
  } else {
    el.chatStatus.textContent = t('chat.engineMissing');
  }
}

// ---------- 外部后端（可选） ----------

async function refreshChatBackends() {
  let res;
  try {
    res = await ML.chatDetect();
  } catch (e) {
    return;
  }
  if (!res.ok) return;
  chatState.backends = res.backends || [];
  const online = chatState.backends.filter((b) => b.online);
  if (chatState.backend && !chatState.backends.find((b) => b.key === chatState.backend && b.online)) {
    chatState.backend = null;
  }
  if (!chatState.backend && online.length && !chatState.engineReady) {
    chatState.backend = online[0].key;
  }
  renderChatBackends();
  if (chatState.backend) {
    const b = chatState.backends.find((x) => x.key === chatState.backend);
    chatState.models = b ? b.models : [];
    renderChatModelSelect();
  }
}

function renderChatBackends() {
  const box = el.chatBackends;
  if (!box) return;
  box.innerHTML = '';
  chatState.backends.forEach((b) => {
    const div = document.createElement('div');
    // installed-but-offline is a valid state: show it, don't hide it.
    let state;
    if (b.online) state = b.models.length + t('chat.modelCount');
    else if (b.key === 'llamacpp' && chatState.engineReady) state = t('chat.engineReadyShort');
    else if (b.key === 'lmstudio' && b.appRunning) state = t('chat.appRunning');
    else if (b.installed) state = t('chat.notRunning');
    else state = t('chat.notInstalled');
    div.className = 'chat-backend ' + (b.online ? 'online' : 'offline') + (chatState.backend === b.key ? ' active' : '');
    div.innerHTML = `
      <span class="chat-backend-dot"></span>
      <span class="chat-backend-name">${esc(b.name)}</span>
      <span class="chat-backend-state">${esc(state)}</span>
    `;
    if (b.online) {
      div.addEventListener('click', () => {
        chatState.backend = b.key;
        chatState.models = b.models;
        renderChatBackends();
        renderChatModelSelect();
        el.chatStatus.textContent = t('chat.connected') + b.name + t('chat.modelCount') + b.models.length;
      });
    } else if (b.installed && (b.key === 'ollama' || b.key === 'lmstudio') && b.canStartService) {
      // Installed but the API service is down — offer a one-click start.
      // For LM Studio this is essential: its GUI chat works while :1234 stays shut.
      const isLm = b.key === 'lmstudio';
      const label = isLm ? t('chat.startApi') : t('chat.startService');
      const btn = document.createElement('button');
      btn.className = 'link-btn chat-start-service';
      btn.textContent = label;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = t('chat.starting');
        const r = isLm ? await ML.chatStartLmStudio(b.port) : await ML.chatStartOllama();
        if (r.ok) {
          showToast(t('chat.serviceStarted'));
          await refreshChatBackends();
        } else {
          showToast(r.error || t('chat.startFail'));
          btn.disabled = false;
          btn.textContent = label;
        }
      });
      div.appendChild(btn);
    }
    box.appendChild(div);
  });
}

// ---------- 模型选择 ----------

function renderChatModelSelect() {
  const prev = chatState.model;
  el.chatModelSelect.innerHTML = '';

  // Built-in engine: local GGUF files.
  const local = collectLocalModels();
  if (local.length) {
    const group = document.createElement('optgroup');
    group.label = t('chat.localTitle');
    local.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.path;
      opt.textContent = m.name + (m.size ? ' · ' + formatSize(m.size) : '');
      group.appendChild(opt);
    });
    el.chatModelSelect.appendChild(group);
  }

  // External backends: their model lists.
  chatState.models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.name;
    const size = m.size ? ' · ' + formatSize(m.size) : '';
    opt.textContent = m.name + size;
    el.chatModelSelect.appendChild(opt);
  });

  if (!el.chatModelSelect.options.length) {
    const opt = document.createElement('option');
    opt.textContent = t('chat.noModel');
    el.chatModelSelect.appendChild(opt);
    chatState.model = null;
  } else {
    if (prev && [...el.chatModelSelect.options].some((o) => o.value === prev)) {
      el.chatModelSelect.value = prev;
    }
    chatState.model = el.chatModelSelect.value;
  }
  renderLocalModelLauncher();
}

// ---------- 对话 ----------

function appendChatMessage(role, content, isError) {
  const welcome = el.chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble' + (isError ? ' chat-error' : '');
  bubble.textContent = content;
  wrap.innerHTML = '<div class="chat-avatar">' + (role === 'user' ? t('chat.user') : t('chat.assistant')) + '</div>';
  wrap.appendChild(bubble);
  if (role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'chat-msg-actions';
    const copy = document.createElement('button');
    copy.className = 'chat-msg-copy';
    copy.textContent = t('chat.copy') || '复制';
    copy.addEventListener('click', async () => {
      const text = bubble.textContent || '';
      if (!text) return;
      try { if (ML.copyText) await ML.copyText(text); } catch (_) { /* ignore */ }
      copy.textContent = t('chat.copied') || '已复制';
      setTimeout(() => { copy.textContent = t('chat.copy') || '复制'; }, 1300);
    });
    actions.appendChild(copy);
    wrap.appendChild(actions);
  }
  el.chatMessages.appendChild(wrap);
  if (role === 'assistant' && content) {
    try { renderAssistantContent(bubble, content); } catch (_) { /* keep raw text */ }
  }
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return bubble;
}

// Make sure a model is loaded and ready before sending.
async function ensureModelReady() {
  if (chatState.backend) return true;          // external backend, already up
  const sel = el.chatModelSelect.value;
  if (!sel || sel === t('chat.noModel')) {
    showToast(t('chat.noBackend'));
    return false;
  }
  // Already running this model?
  const det = await ML.engineDetect();
  if (det.ok && det.status.running && det.status.model === sel) {
    chatState.model = sel;
    chatState.engineRunning = true;
    return true;
  }
  // Find the local model record so we can launch it.
  const m = chatState.localModels.find((x) => x.path === sel);
  if (!m) {
    showToast(t('chat.noLocalModel'));
    return false;
  }
  chatState.model = sel;
  return await launchEngineWith(m);
}

// Render clickable source links beneath an answer that used web search.
function attachSearchSources(bubble, results) {
  if (!bubble || !results || !results.length) return;
  const box = document.createElement('div');
  box.className = 'chat-sources';
  const label = document.createElement('div');
  label.className = 'chat-sources-label';
  label.textContent = t('chat.sources') || '参考来源';
  box.appendChild(label);
  results.forEach((s, i) => {
    const a = document.createElement('a');
    a.className = 'chat-source-link';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '[' + (i + 1) + '] ' + (s.title || s.url);
    a.title = s.url;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (ML.openExternal) ML.openExternal(s.url);
    });
    box.appendChild(a);
    // Show the retrieved snippet so the user can see the real evidence even
    // if a small local model fails to summarise it well.
    if (s.snippet) {
      const snip = document.createElement('div');
      snip.className = 'chat-source-snippet';
      snip.textContent = s.snippet.length > 130 ? s.snippet.slice(0, 130) + '…' : s.snippet;
      box.appendChild(snip);
    }
  });
  bubble.parentElement.appendChild(box);
}

// Turn [[ACTION:key|param]] markers in an answer into confirmable action cards.
// The marker text is stripped from the visible answer; execution only happens
// when the user clicks the card's button.
function renderAssistantContent(bubble, raw) {
  const re = /\[\[ACTION:([a-z_]+)(?:\|([^\]]+))?\]\]/g;
  const actions = [];
  let match;
  while ((match = re.exec(raw || ''))) {
    actions.push({ key: match[1], param: (match[2] || '').trim() });
  }
  const clean = String(raw || '').replace(re, '').trim();
  bubble.textContent = clean || (actions.length
    ? '已准备好下面的操作，点「执行」后才会真正运行：'
    : (t('chat.emptyReply') || ''));

  const wrap = bubble.parentElement;
  if (!wrap) return actions;
  wrap.querySelectorAll('.chat-action-card').forEach((x) => x.remove());

  const LABELS = {
    open_app: '打开应用', open_url: '打开网页', open_path: '打开文件或文件夹',
    create_file: '创建文本文件', system_info: '查看电脑配置',
    download_software: '下载软件',
  };
  const APPS = {
    notepad: '记事本', calc: '计算器', explorer: '文件资源管理器',
    edge: 'Edge 浏览器', chrome: 'Chrome 浏览器', code: 'VS Code',
    settings: '系统设置', taskmgr: '任务管理器', powershell: 'PowerShell', cmd: '命令提示符',
  };

  actions.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'chat-action-card';
    const info = document.createElement('div');
    info.className = 'chat-action-info';
    const label = document.createElement('span');
    label.className = 'chat-action-label';
    label.textContent = LABELS[a.key] || a.key;
    const detail = document.createElement('span');
    detail.className = 'chat-action-detail';
    detail.textContent = a.key === 'open_app' ? (APPS[a.param] || a.param) : a.param;
    info.appendChild(label);
    info.appendChild(detail);
    card.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'chat-action-run';
    btn.textContent = '执行';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '执行中…';
      try {
        const opts = {};
        if (a.key === 'create_file') opts.content = clean;
        const r = await ML.assistantAction(a.key, a.param, opts);
        if (r && r.ok) {
          btn.textContent = '已执行';
          showToast(r.message || '完成');
        } else if (r && r.canceled) {
          btn.disabled = false;
          btn.textContent = '执行';
        } else {
          btn.disabled = false;
          btn.textContent = '重试';
          showToast(t('chat.error') + ((r && r.error) || t('chat.unknown')));
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '重试';
        showToast(t('chat.error') + e.message);
      }
    });
    card.appendChild(btn);
    wrap.appendChild(card);
  });
  return actions;
}

// ---- Tool-use loop: search and computer actions are model tools ----------
// Regression audits can script model replies through this seam; normal use
// never sets it, so the real engine / external backend path stays untouched.
let modelTransportOverride = null;
const MAX_TOOL_ROUNDS = 4;
const TOOL_LABELS = {
  open_app: '打开应用', open_url: '打开网页', open_path: '打开文件或文件夹',
  list_dir: '列出目录', read_file: '读取文件', system_info: '查看电脑配置',
  clipboard_write: '写入剪贴板', create_file: '创建文本文件',
  write_file: '写入文件', run_script: '运行脚本', download_software: '下载软件',
};

function parseToolCalls(raw) {
  const text = String(raw || '');
  const re = /\[\[(SEARCH|ACTION|SCRIPT):([\s\S]*?)\]\]/g;
  const calls = [];
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase();
    const body = m[2].trim();
    if (kind === 'search' && body) {
      calls.push({ kind, query: body });
    } else if (kind === 'action') {
      const i = body.indexOf('|');
      const key = (i < 0 ? body : body.slice(0, i)).trim();
      const param = (i < 0 ? '' : body.slice(i + 1)).trim();
      if (key) calls.push({ kind, key, param });
    } else if (kind === 'script' && body) {
      calls.push({ kind, script: body });
    }
  }
  return { calls: calls.slice(0, 2), clean: text.replace(re, '').trim() };
}

function appendToolLog(wrap, icon, label, detail, resultText, ok) {
  let log = wrap.querySelector('.chat-tool-log');
  if (!log) {
    log = document.createElement('div');
    log.className = 'chat-tool-log';
    wrap.appendChild(log);
  }
  const row = document.createElement('div');
  row.className = 'chat-tool-row' + (ok === false ? ' is-error' : '');
  const head = document.createElement('div');
  head.className = 'chat-tool-row-head';
  head.textContent = icon + ' ' + label + (detail ? ' · ' + detail : '');
  const res = document.createElement('div');
  res.className = 'chat-tool-row-result';
  res.textContent = resultText || '执行中…';
  row.appendChild(head);
  row.appendChild(res);
  log.appendChild(row);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return res;
}

function describeTool(call) {
  if (call.kind === 'search') return { icon: '🔍', label: '联网搜索', detail: call.query };
  if (call.kind === 'script') {
    return { icon: '⌘', label: '运行脚本', detail: call.script.replace(/\s+/g, ' ').slice(0, 70) };
  }
  return { icon: '⚙', label: TOOL_LABELS[call.key] || call.key, detail: call.param };
}

// Privacy guard: refuse to send local file paths / attached-file content out
// to Bing. Search queries must be generic public keywords only.
function unsafeSearchQuery(q) {
  const s = String(q || '');
  if (/[a-z]:\\|\\\\|file:\/\//i.test(s)) return '搜索词包含本地路径';
  if (/\.{0,3}(txt|md|csv|docx|xlsx|pdf|gguf)\b/i.test(s) && /\b(user|users|desktop|documents|downloads|桌面|文档|下载)\b/i.test(s)) {
    return '搜索词包含本地文件名';
  }
  // If a query reproduces a long chunk of an attached file, block it.
  for (const f of (chatState.contextFiles || [])) {
    const content = String(f.content || '').replace(/\s+/g, ' ').trim();
    if (content.length >= 24 && content.slice(0, 200).includes(s.replace(/\s+/g, ' ').trim().slice(0, 24))) {
      return '搜索词疑似复制了附加文件的内容';
    }
  }
  return null;
}

async function executeToolCall(call, searchEnabled) {
  if (call.kind === 'search') {
    if (!searchEnabled || !ML.webSearch) {
      return { ok: false, result: '联网搜索未开启', history: '' };
    }
    const unsafe = unsafeSearchQuery(call.query);
    if (unsafe) {
      return { ok: false, result: '出于隐私保护，搜索被拒绝：' + unsafe + '。请改用不包含本地信息的通用关键词。', history: '' };
    }
    try {
      const sr = await ML.webSearch(call.query);
      if (!sr || !sr.ok || !sr.results || !sr.results.length) {
        return { ok: false, result: '没有搜到结果', history: '' };
      }
      const lines = sr.results.slice(0, 6).map((s, i) =>
        '[' + (i + 1) + '] ' + (s.title || s.url) + '\n' + (s.snippet || '') + '\n' + s.url
      );
      const history = '【工具结果：联网搜索】\n查询：' + call.query + '\n'
        + lines.join('\n')
        + '\n请只依据以上真实结果回答，不要编造。结果不足就说没有找到明确答案。';
      return { ok: true, result: '找到 ' + sr.results.length + ' 条结果', history, results: sr.results };
    } catch (e) {
      return { ok: false, result: '搜索失败：' + e.message, history: '' };
    }
  }
  try {
    const key = call.kind === 'script' ? 'run_script' : call.key;
    const param = call.kind === 'script' ? '' : call.param;
    const opts = call.kind === 'script' ? { script: call.script } : {};
    const r = await ML.assistantAction(key, param, opts);
    if (!r) return { ok: false, result: '工具无返回', history: '' };
    if (r.canceled) return { ok: false, result: '你取消了操作', history: '' };
    const out = String(r.message || r.error || '').trim();
    const short = out.length > 240 ? out.slice(0, 240) + '…' : out;
    const history = '【工具结果：' + (TOOL_LABELS[key] || key) + '】\n'
      + (r.ok ? '成功' : '失败') + '：\n' + out.slice(0, 8000)
      + '\n请基于这个真实结果继续回答，不要重复执行同一个操作。';
    return { ok: !!r.ok, result: (r.ok ? '✓ ' : '✗ ') + short, history };
  } catch (e) {
    return { ok: false, result: '执行失败：' + e.message, history: '' };
  }
}

async function sendChatMessage() {
  const text = el.chatInput.value.trim();
  if (!text) return;
  if (chatState.streaming) { showToast(t('chat.busy')); return; }

  el.chatInput.value = '';
  appendChatMessage('user', text);
  chatState.history.push({ role: 'user', content: text });
  persistSessions();

  const bubble = appendChatMessage('assistant', '');
  const wrap = bubble.parentElement;
  const webToggle = document.getElementById('chat-web-toggle');
  const searchEnabled = !!(webToggle && webToggle.checked);

  chatState.streaming = true;
  chatState.pending = true;
  el.chatSend.disabled = true;
  el.chatStop.classList.remove('hidden');

  const sysParts = [];
  const workCtx = buildWorkContext(searchEnabled);
  if (workCtx) sysParts.push(workCtx);
  let workingHistory = sysParts.length
    ? [{ role: 'system', content: sysParts.join('\n\n') }].concat(chatState.history)
    : chatState.history.slice();

  let finalContent = '';
  let finalError = '';
  let aborted = false;
  let interrupted = false;
  const allSources = [];

  try {
    const ready = await ensureModelReady();
    if (!ready) {
      finalError = t('chat.noBackend');
    } else {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (!chatState.pending) { interrupted = true; break; }
        bubble.textContent = '';
        const reqId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        chatState.reqId = reqId;
        const opts = {
          temperature: Number(el.chatTemp.value),
          ctx: Number(el.chatCtx.value),
          maxTokens: 2048,
          reqId,
        };
        let r;
        try {
          if (modelTransportOverride) {
            r = await modelTransportOverride(workingHistory, opts);
          } else if (chatState.backend) {
            r = await ML.chatSend(chatState.backend, chatState.model, workingHistory, opts);
          } else {
            r = await ML.engineChat(workingHistory, opts);
          }
        } catch (e) {
          r = { ok: false, error: e.message };
        }
        chatState.reqId = '';
        if (!r.ok) { finalError = friendlyEngineError({ message: r.error || t('chat.unknown') }); break; }
        if (r.aborted) { aborted = true; break; }

        const raw = r.content || '';
        const parsed = parseToolCalls(raw);
        finalContent = parsed.clean;
        if (!chatState.pending) { interrupted = true; break; }
        if (!parsed.calls.length || round === MAX_TOOL_ROUNDS) {
          if (parsed.calls.length) {
            appendToolLog(wrap, '⏹', '达到工具调用上限', '', '已停止继续调用工具，下面是当前回答', false);
          }
          break;
        }

        if (parsed.clean) appendToolLog(wrap, '💭', '模型正在调用工具', parsed.clean.slice(0, 140));
        const toolMessages = [{ role: 'assistant', content: raw }];
        for (const call of parsed.calls) {
          const d = describeTool(call);
          const resNode = appendToolLog(wrap, d.icon, d.label, d.detail, '执行中…');
          const res = await executeToolCall(call, searchEnabled);
          resNode.textContent = res.result;
          resNode.classList.toggle('is-error', !res.ok);
          if (res.results && res.results.length) allSources.push(...res.results);
          if (res.history) toolMessages.push({ role: 'user', content: res.history });
          if (!chatState.pending) { interrupted = true; break; }
        }
        workingHistory = workingHistory.concat(toolMessages);
        if (interrupted) break;
      }
    }
  } catch (e) {
    finalError = friendlyEngineError(e);
  }

  chatState.pending = false;
  chatState.streaming = false;
  chatState.reqId = '';
  el.chatSend.disabled = false;
  el.chatStop.classList.add('hidden');

  const partial = (bubble.textContent || '').trim();
  if (finalError) {
    bubble.textContent = finalError;
    bubble.classList.add('chat-error');
  } else if (aborted || interrupted) {
    const keep = partial || finalContent;
    if (keep) {
      renderAssistantContent(bubble, keep);
      chatState.history.push({ role: 'assistant', content: keep });
    }
  } else {
    renderAssistantContent(bubble, finalContent);
    if (finalContent) chatState.history.push({ role: 'assistant', content: finalContent });
  }
  if (allSources.length) attachSearchSources(bubble, allSources);
  persistSessions();
  renderChatSessions();
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

// 流式增量
ML.onChatDelta(({ delta }) => {
  if (!delta) return;
  // Guard: deltas that arrive after the request already resolved would duplicate
  // text (the final content already contains them).
  if (!chatState.streaming) return;
  const bubbles = el.chatMessages.querySelectorAll('.chat-msg.assistant .chat-bubble');
  if (!bubbles.length) return;
  const last = bubbles[bubbles.length - 1];
  last.textContent += delta;
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
});

el.chatSend.addEventListener('click', sendChatMessage);
el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
el.chatStop.addEventListener('click', async () => {
  if (!chatState.pending) return;
  chatState.pending = false;
  el.chatStop.classList.add('hidden');
  // Kill the actual HTTP request so the model stops generating on the GPU.
  // The pending chat-send/engine-chat call resolves with {aborted:true}.
  const reqId = chatState.reqId;
  chatState.reqId = '';
  if (reqId) {
    try {
      if (chatState.backend) await ML.chatAbort(reqId);
      else await ML.engineAbort(reqId);
    } catch (e) { /* request may already have finished */ }
  }
  showToast(t('chat.stopping'));
});
el.chatModelSelect.addEventListener('change', () => {
  chatState.model = el.chatModelSelect.value;
  // Switching to an external backend model? keep backend selection consistent.
  const isLocal = chatState.localModels.some((m) => m.path === chatState.model);
  if (isLocal) chatState.backend = null;
  else if (!chatState.backend && chatState.models.some((m) => m.name === chatState.model)) {
    chatState.backend = chatState.backends.find((b) => b.models.some((m) => m.name === chatState.model))?.key || null;
  }
});
el.chatTemp.addEventListener('input', () => {
  el.chatTempVal.textContent = Number(el.chatTemp.value).toFixed(1);
});
if (el.chatBackendPref) el.chatBackendPref.addEventListener('change', async () => {
  try { await ML.saveSettings({ backendPreference: el.chatBackendPref.value }); } catch (_) {}
  await refreshEngineStatus();
});
(async () => {
  try {
    const s = await ML.loadSettings();
    if (s && s.backendPreference && el.chatBackendPref) el.chatBackendPref.value = s.backendPreference;
  } catch (_) {}
})();
const importBtn = document.getElementById('btn-import-gguf');
if (importBtn) importBtn.addEventListener('click', importGgufFiles);
const attachBtn = document.getElementById('btn-chat-attach');
if (attachBtn) attachBtn.addEventListener('click', attachContextFiles);
const exportBtn = document.getElementById('btn-chat-export');
if (exportBtn) exportBtn.addEventListener('click', exportChat);
const modeSel = document.getElementById('chat-mode');
if (modeSel) modeSel.addEventListener('change', () => { chatState.mode = modeSel.value; });

// Delegation keeps welcome-screen buttons alive after the DOM is re-rendered
// when switching or creating a session.
if (el.chatMessages) {
  el.chatMessages.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-wc-action]');
    if (hit) applyWelcomePrompt(hit.getAttribute('data-wc-action'));
  });
}

document.getElementById('btn-chat-new').addEventListener('click', () => {
  if (chatState.streaming) { showToast(t('chat.busy')); return; }
  persistSessions();
  createSession();
  chatState.contextFiles = [];
  renderContextBar();
  renderChatSessions();
  renderHistoryMessages();
  persistSessions(true);
});

// Drop files straight onto the composer — the fastest way to work with a document.
const composer = document.querySelector('.chat-composer');
if (composer) {
  composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    composer.classList.add('drag-over');
  });
  composer.addEventListener('dragleave', (e) => {
    if (!composer.contains(e.relatedTarget)) composer.classList.remove('drag-over');
  });
  composer.addEventListener('drop', async (e) => {
    e.preventDefault();
    composer.classList.remove('drag-over');
    const paths = Array.from(e.dataTransfer.files || []).map((f) => f.path).filter((p) => !!p);
    if (paths.length) await ingestContextPaths(paths);
  });
}

// 模型详情面板关闭按钮
const mdClose = document.getElementById('md-close');
if (mdClose) mdClose.addEventListener('click', () => {
  el.modelDetail.classList.add('hidden');
  el.detailEmpty.classList.remove('hidden');
  state.hfSelected = null;
  renderHfResults();
});

// 下载任务面板折叠
const btnCollapseQueue = document.getElementById('btn-collapse-queue');
if (btnCollapseQueue) {
  btnCollapseQueue.addEventListener('click', () => {
    const pane = btnCollapseQueue.closest('.download-queue-pane');
    pane.classList.toggle('collapsed');
    btnCollapseQueue.textContent = pane.classList.contains('collapsed') ? '▴' : '▾';
  });
}

// ============================================================
// 工作工具箱 —— 文档 / 电脑 / 搜索 / 软件
// ============================================================
let toolsInited = false;

function goToTools(anchorId) {
  const nav = document.querySelector('.nav-item[data-view="tools"]');
  if (nav) nav.click();
  if (anchorId) {
    setTimeout(() => {
      const target = document.getElementById(anchorId);
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }
}

async function initToolsView() {
  if (!toolsInited) {
    toolsInited = true;
    bindToolsEvents();
  }
  await renderSoftwareGrid(document.getElementById('software-search')?.value || '');
}

function bindToolsEvents() {
  const search = document.getElementById('software-search');
  if (search) search.addEventListener('input', () => renderSoftwareGrid(search.value));

  const pick = document.getElementById('tool-pick-doc');
  if (pick) pick.addEventListener('click', attachContextFiles);

  const drop = document.getElementById('doc-drop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('drag-over');
      const paths = Array.from(e.dataTransfer.files || []).map((f) => f.path).filter((p) => !!p);
      if (paths.length) await previewDocuments(paths);
    });
  }

  // Example prompts drop the user straight into the chat with the right tool
  // enabled. Search and computer control are no longer standalone buttons.
  document.querySelectorAll('.tool-example').forEach((btn) => {
    btn.addEventListener('click', () => {
      goToChatWithPrompt(btn.getAttribute('data-chat-prompt') || '',
        btn.getAttribute('data-chat-web') === '1');
    });
  });

  if (ML.onSoftwareDownloadDone) {
    ML.onSoftwareDownloadDone((data) => {
      showToast(data && data.ok
        ? data.name + ' 下载完成：' + data.path
        : (data ? data.name + ' 下载失败：' + (data.error || '') : '下载失败'));
    });
  }
}

async function renderSoftwareGrid(query) {
  const grid = document.getElementById('software-grid');
  if (!grid || !ML.softwareList) return;
  const r = await ML.softwareList(query || '');
  const items = (r && r.items) || [];
  grid.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'software-empty';
    empty.textContent = '没有匹配的软件';
    grid.appendChild(empty);
    return;
  }
  items.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'software-card';

    const head = document.createElement('div');
    head.className = 'software-card-head';
    const name = document.createElement('strong');
    name.textContent = s.name;
    const cat = document.createElement('span');
    cat.className = 'software-cat';
    cat.textContent = s.category;
    head.appendChild(name);
    head.appendChild(cat);

    const desc = document.createElement('p');
    desc.textContent = s.desc;

    const actions = document.createElement('div');
    actions.className = 'software-actions';
    const dl = document.createElement('button');
    dl.className = 'software-dl';
    dl.textContent = '下载';
    dl.addEventListener('click', async () => {
      const res = await ML.assistantAction('download_software', s.id);
      if (res && res.ok) {
        dl.textContent = '已加入下载';
        showToast(res.message);
      } else {
        showToast(t('chat.error') + ((res && res.error) || t('chat.unknown')));
      }
    });
    const site = document.createElement('button');
    site.className = 'software-site';
    site.textContent = '官网';
    site.addEventListener('click', () => ML.openExternal(s.site));
    actions.appendChild(dl);
    actions.appendChild(site);

    card.appendChild(head);
    card.appendChild(desc);
    card.appendChild(actions);
    grid.appendChild(card);
  });
}

async function previewDocuments(paths) {
  const r = await ML.readContextFiles(paths);
  if (!r || !r.ok) return;
  const box = document.getElementById('doc-preview');
  if (!box) return;
  box.innerHTML = '';
  box.classList.remove('hidden');
  let added = 0;
  r.files.forEach((f) => {
    if (f.error) { showToast(f.name + '：' + f.error); return; }
    chatState.contextFiles = chatState.contextFiles.filter((x) => x.path !== f.path);
    chatState.contextFiles.push(f);
    added++;
    const card = document.createElement('div');
    card.className = 'doc-preview-card';
    const head = document.createElement('div');
    head.className = 'doc-preview-head';
    head.textContent = f.name + ' · ' + String(f.type || 'txt').toUpperCase() + ' · ' + f.content.length + ' 字' + (f.truncated ? '（已截断）' : '');
    const pre = document.createElement('pre');
    pre.textContent = f.content.slice(0, 1200) + (f.content.length > 1200 ? '\n…（剩余内容已加入对话上下文）' : '');
    card.appendChild(head);
    card.appendChild(pre);
    box.appendChild(card);
  });
  renderContextBar();
  if (added) showToast(t('chat.filesAdded') + added);
}

async function runToolSearch() {
  const input = document.getElementById('tool-search-input');
  const box = document.getElementById('tool-search-results');
  const q = (input && input.value || '').trim();
  if (!q || !box) return;
  box.textContent = t('chat.searching') || '正在搜索...';
  try {
    const r = await ML.webSearch(q);
    box.innerHTML = '';
    if (!r || !r.ok || !r.results || !r.results.length) {
      box.textContent = t('chat.searchFail') || '没有找到结果';
      return;
    }
    r.results.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'tool-result';
      const title = document.createElement('a');
      title.className = 'tool-result-title';
      title.textContent = '[' + (i + 1) + '] ' + (s.title || s.url);
      title.setAttribute('href', '#');
      title.addEventListener('click', (e) => { e.preventDefault(); ML.openExternal(s.url); });
      const snip = document.createElement('p');
      snip.textContent = s.snippet || s.url;
      row.appendChild(title);
      row.appendChild(snip);
      box.appendChild(row);
    });
  } catch (e) {
    box.textContent = t('chat.error') + e.message;
  }
}
