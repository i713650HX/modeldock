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

function buildCommands(m) {
  const p = '"' + m.path.replace(/"/g, '\\"') + '"';
  const server = 'llama-server -m ' + p + ' --ctx-size ' + ((m.meta && m.meta.contextLength) || 4096);
  const ollama = 'ollama create mymodel -f Modelfile  # Modelfile: FROM ' + p;
  return { server, ollama };
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
    if (state.view === 'download') {
      el.libraryView.classList.add('hidden');
      el.downloadView.classList.remove('hidden');
    } else {
      el.downloadView.classList.add('hidden');
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
document.getElementById('direct-url-btn').addEventListener('click', startDirectDownload);
document.getElementById('direct-url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startDirectDownload();
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
// Featured models map directly to ModelScope GGUF repos (domestic-friendly, no search API needed).
const FEATURED = [
  { label: 'Qwen2.5 7B（中文强）', repo: 'Qwen/Qwen2.5-7B-Instruct-GGUF' },
  { label: 'Qwen2.5 14B', repo: 'Qwen/Qwen2.5-14B-Instruct-GGUF' },
  { label: 'Gemma 3 4B（轻量）', repo: 'ggml-org/gemma-3-4b-it-GGUF' },
  { label: 'DeepSeek R1 7B', repo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF' },
  { label: 'Llama 3.2 3B', repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF' },
  { label: 'Qwen2.5 Coder（代码）', repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' },
];
(function renderFeatured() {
  const box = document.getElementById('featured-chips');
  if (!box) return;
  FEATURED.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'secondary-btn small-btn';
    btn.textContent = item.label;
    btn.title = '直接从 ModelScope 打开：' + item.repo;
    btn.addEventListener('click', () => {
      // Open the repo's file list on the domestic ModelScope source directly.
      el.hfSourceSelect.value = 'ms';
      showHfFiles({ id: item.repo, name: item.repo.split('/').pop(), source: 'ms' }, 'master');
    });
    box.appendChild(btn);
  });
})();

// ---- Hugging Face downloader UI ----
async function doSearch() {
  const q = el.hfSearchInput.value.trim();
  if (!q) { showToast('请输入模型名称'); return; }
  const source = el.hfSourceSelect.value;
  // ModelScope search API requires auth; accept a repo ID (ns/name) and go straight to its file list.
  if (source === 'ms') {
    if (!/^[\w.\-]+\/[\w.\-]+$/.test(q)) {
      showToast('魔搭源请粘贴模型 ID（格式：命名空间/模型名，如 qwen/Qwen2.5-7B-Instruct）');
      return;
    }
    await showHfFiles({ id: q, name: q.split('/').pop(), source: 'ms' }, 'master');
    return;
  }
  const typeFilter = document.getElementById('hf-type-select').value;
  // Try the chosen source first, then fall back to the others (mirror/HF are flaky in CN).
  const order = [source, ...['mirror', 'hf'].filter(s => s !== source)];
  el.hfHint.innerHTML = '<p>' + t('dl.searching') + '</p>';
  el.hfHint.classList.remove('hidden');
  el.hfResults.innerHTML = '';
  let lastErr = null;
  for (const src of order) {
    try {
      const r = await ML.hfSearch(q, src, typeFilter);
      if (!r.ok) throw new Error(r.error);
      state.hfModels = r.models;
      state.hfSelected = null;
      el.hfHint.classList.add('hidden');
      renderHfResults();
      if (src !== source) showToast('已自动切换「' + (src === 'mirror' ? '国内镜像' : 'Hugging Face') + '」源完成搜索');
      return;
    } catch (err) {
      lastErr = err;
      el.hfHint.innerHTML = '<p>' + t('dl.searching') + '（切换备用源 ' + (src === 'mirror' ? '国内镜像' : 'Hugging Face') + '...）</p>';
    }
  }
  el.hfHint.innerHTML = `<h2>${t('dl.searchFail')}</h2><p>${esc(lastErr?.message || '')}</p><p style="margin-top:8px;color:var(--text-tertiary)">建议：改用「ModelScope 魔搭」源粘贴模型 ID，或点下方精选推荐（直接走国内源）。</p>`;
  el.hfHint.classList.remove('hidden');
}

function renderHfResults() {
  el.hfResults.innerHTML = '';
  if (!state.hfModels.length) {
    el.hfHint.innerHTML = '<h2>' + t('dl.noResult') + '</h2><p>' + t('dl.noResultHint') + '</p>';
    el.hfHint.classList.remove('hidden');
    return;
  }
  state.hfModels.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'hf-card' + (state.hfSelected && state.hfSelected.id === m.id ? ' selected' : '');
    const fmtNum = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    card.innerHTML = `
      <div class="hf-card-title">${esc(m.id)}</div>
      <div class="hf-card-meta">
        <span>下载 ${fmtNum(m.downloads)}</span>
        <span>喜欢 ${fmtNum(m.likes)}</span>
        ${m.pipeline ? `<span>${esc(m.pipeline)}</span>` : ''}
      </div>
      <div class="hf-card-tags">${(m.tags || []).slice(0, 5).map((t) => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>
    `;
    card.addEventListener('click', () => showHfFiles(m));
    el.hfResults.appendChild(card);
  });
}

async function showHfFiles(m, revision) {
  state.hfSelected = m;
  state.hfRevision = revision || (m.source === 'ms' ? 'master' : 'main');
  el.hfHint.classList.add('hidden');
  el.hfResults.innerHTML = '<div class="hf-files-wrap"><div class="hf-files-title">加载文件列表...</div></div>';
  try {
    const r = await ML.hfFiles(m.id, m.source, state.hfRevision);
    if (!r.ok) throw new Error(r.error);
    const wrap = document.createElement('div');
    wrap.className = 'hf-files-wrap';
    // Quant filter chips (dynamically from files that carry a quant tag)
    const quants = [...new Map(r.files.filter(f => f.quant).map(f => [f.quant.toUpperCase().trim(), f.quant.toUpperCase().trim()])).values()];
    const filterChips = quants.length
      ? '<div class="cmd-hint" style="margin:6px 0">按量化筛选：' + quants.map(q => `<button class="hf-quant-chip" data-q="${esc(q)}">${esc(q)}</button>`).join(' ') + ' <button class="hf-quant-chip" data-q="">全部</button></div>'
      : '';
    wrap.innerHTML = `
      <div class="hf-files-title">
        <button class="hf-files-back">返回</button>
        <span>${esc(m.name)} 的文件 (${r.files.length})</span>
      </div>
      <div class="cmd-hint" style="margin-bottom:6px">分支/版本：<input id="hf-revision-input" class="detail-input" style="width:180px;display:inline-block" value="${esc(state.hfRevision)}" /> <button id="hf-revision-go" class="secondary-btn small-btn">切换</button></div>
      ${filterChips}
      <div class="cmd-hint" style="margin-bottom:10px">模型文件排在前面；可按目录/量化筛选。点击下载保存到设定目录。</div>
    `;
    wrap.querySelector('.hf-files-back').addEventListener('click', renderHfResults);
    wrap.querySelector('#hf-revision-go').addEventListener('click', () => {
      showHfFiles(m, wrap.querySelector('#hf-revision-input').value.trim());
    });
    wrap.querySelectorAll('.hf-quant-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-q');
        wrap.querySelectorAll('.hf-file-row').forEach(row => {
          row.style.display = (!q || (row.getAttribute('data-quant') || '').toUpperCase() === q) ? '' : 'none';
        });
      });
    });
    if (!r.files.length) {
      wrap.innerHTML += '<div class="cmd-hint">这个仓库没有可下载的文件。</div>';
    }
    r.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'hf-file-row';
      row.setAttribute('data-quant', (f.quant || '').toUpperCase());
      const sizeText = f.size ? formatSize(f.size) : '';
      row.innerHTML = `
        <span class="hf-file-name" title="${esc(f.path)}">${esc(f.name)}</span>
        ${f.quant ? `<span class="hf-file-quant">${esc(f.quant)}</span>` : ''}
        <span class="card-tag">${esc(f.type || '文件')}</span>
        ${f.size ? fitBadgeHtml(assessFitLocal(f.size)) : ''}
        ${sizeText ? `<span class="hf-file-size">${sizeText}</span>` : ''}
        <button class="hf-file-download">下载</button>
      `;
      row.querySelector('.hf-file-download').addEventListener('click', () => {
        startDownload(m, f);
      });
      wrap.appendChild(row);
    });
    el.hfResults.innerHTML = '';
    el.hfResults.appendChild(wrap);
  } catch (err) {
    el.hfResults.innerHTML = `<div class="hf-files-wrap"><button class="hf-files-back">返回</button><p>加载失败：${esc(err.message)}</p></div>`;
    el.hfResults.querySelector('.hf-files-back').addEventListener('click', renderHfResults);
  }
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

async function startDownload(model, file) {
  const dir = await ensureDownloadDir();
  if (!dir) { showToast('请选择下载目录'); return; }
  // check disk space before starting
  if (file.size) {
    const space = await ML.checkDiskSpace(dir, file.size * 1.1); // 10% headroom
    if (space.ok && !space.enough) {
      showToast('磁盘空间不足，需要 ' + formatSize(file.size) + '，可用 ' + formatSize(space.free));
      return;
    }
  }
  const id = 'dl-' + (++state.downloadSeq) + '-' + Date.now();
  const task = { id, repoId: model.id, file, destDir: dir, sourceKey: model.source, kind: 'repo', revision: state.hfRevision || undefined };
  state.downloads[id] = {
    id, name: file.name, status: 'pending', loaded: 0, total: file.size || 0, speed: 0, task,
  };
  enqueueDownload(task, state.downloads[id]);
}

// ---- Direct URL download ----
async function startDirectDownload() {
  const input = document.getElementById('direct-url-input');
  const url = input.value.trim();
  if (!url) { showToast('请粘贴下载链接'); return; }
  if (!/^https?:\/\//i.test(url)) { showToast('链接需以 http:// 或 https:// 开头'); return; }
  const dir = await ensureDownloadDir();
  if (!dir) { showToast('请选择下载目录'); return; }
  const id = 'url-' + (++state.downloadSeq) + '-' + Date.now();
  // infer filename from URL for display
  let name = 'file-' + Date.now();
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').pop()) || name;
  } catch (e) { /* keep generic name */ }
  const task = { id, url, fileName: name, destDir: dir, kind: 'url' };
  state.downloads[id] = { id, name, status: 'pending', loaded: 0, total: 0, speed: 0, task };
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
  state.gpus = await ML.getGpus();
  state.brands = await ML.getBrands();
  renderGpuInfo();
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
