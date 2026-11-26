const api = window.api;

// ---- Local error logging (forwarded to main process file, never uploaded) ----
window.addEventListener('error', (e) => {
  try { api.log('error', 'window.onerror: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { api.log('error', 'unhandledrejection: ' + String(e.reason && e.reason.message || e.reason)); } catch (_) {}
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
      await api.saveFolders(state.folders);
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
    list = list.filter((m) => {
      if (m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q)) return true;
      const nm = noteFor(m);
      if (nm.note && nm.note.toLowerCase().includes(q)) return true;
      if (nm.tags && nm.tags.some((t) => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }
  switch (state.sort) {
    case 'size': list.sort((a, b) => b.size - a.size); break;
    case 'modified': list.sort((a, b) => b.modified - a.modified); break;
    case 'context':
      list.sort((a, b) => ((b.meta && b.meta.contextLength) || 0) - ((a.meta && a.meta.contextLength) || 0));
      break;
    default: list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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

  let totalSize = 0;
  list.forEach((m) => totalSize += m.size);
  el.statSize.textContent = formatSize(totalSize);

  if (list.length === 0) {
    el.modelList.style.display = 'none';
    el.emptyState.classList.remove('hidden');
    if (state.models.length === 0) {
      el.emptyTitle.textContent = '没有找到模型';
      el.emptyDesc.textContent = '添加一个包含 .gguf 模型文件的文件夹即可开始。';
    } else {
      el.emptyTitle.textContent = '没有匹配的模型';
      el.emptyDesc.textContent = '换个关键词、架构或量化方式试试。';
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
    if (meta.quantization) badges.push(`<span class="card-tag quant">${esc(meta.quantization)}</span>`);
    if (meta.architecture) badges.push(`<span class="card-tag">${esc(meta.architecture)}</span>`);
    if (meta.contextLength) badges.push(`<span class="card-tag ctx">${Math.round(meta.contextLength / 1024)}K 上下文</span>`);
    const param = formatParamCount(meta.parameterCount);
    if (param) badges.push(`<span class="card-tag">${esc(param)} 参数</span>`);
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
            const ok = await api.showInFolder(p);
            if (!ok) showToast('文件夹打开失败，路径可能已失效');
          } else {
            await api.copyText(p);
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
  el.detailPath.textContent = m.path;
  el.detailSha.textContent = '';
  el.detailSha.removeAttribute('data-cmd');

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
    state.models = await api.scanModels(state.folders);
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
  const dir = await api.pickDirectory();
  if (!dir) return;
  if (!state.folders.includes(dir)) {
    state.folders.push(dir);
    await api.saveFolders(state.folders);
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

document.getElementById('btn-save-note').addEventListener('click', async () => {
  if (!state.currentModel) return;
  const tags = el.detailTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const note = el.detailNote.value.trim();
  const ok = await api.saveNote(state.currentModel.path, { tags, note });
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
    await api.copyText(text);
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
  const result = await api.exportCsv(rows);
  if (result.canceled) return;
  if (result.ok) showToast('清单已导出：' + result.path);
  else showToast('导出失败：' + (result.error || '未知错误'));
}

// ---- About dialog ----
async function openAbout() {
  try {
    const info = await api.getAppInfo();
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
      await api.saveFolders(state.folders);
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
    const settings = await api.loadSettings();
    if (settings && settings.scanDepth) el.settingsDepth.value = String(settings.scanDepth);
  } catch (e) { /* keep default */ }
  el.settingsModal.classList.remove('hidden');
}

el.settingsDepth.addEventListener('change', async () => {
  const depth = Number(el.settingsDepth.value);
  const ok = await api.saveSettings({ scanDepth: depth });
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
    const r = await api.fileSha256(state.currentModel.path);
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

el.detailSha.addEventListener('click', async () => {
  const text = el.detailSha.getAttribute('data-cmd');
  if (!text) return;
  await api.copyText(text);
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
  const dir = await api.pickDownloadDir();
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
    const r = await api.getLicenses();
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
    const r = await api.getGuide();
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
  const ok = await api.openLicenseFile('LICENSE.electron.txt');
  if (!ok) showToast('未找到 Electron 许可证文件');
});
document.getElementById('license-open-chromium').addEventListener('click', async () => {
  const ok = await api.openLicenseFile('LICENSES.chromium.html');
  if (!ok) showToast('未找到 Chromium 许可证文件');
});
document.getElementById('license-open-notices').addEventListener('click', async () => {
  const ok = await api.openLicenseFile('THIRD_PARTY_NOTICES.md');
  if (!ok) showToast('未找到完整致谢文件');
});
el.settingsClose.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
el.settingsModal.addEventListener('click', (e) => {
  if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden');
});
el.settingsAddFolder.addEventListener('click', async () => {
  const dir = await api.pickDirectory();
  if (dir && !state.folders.includes(dir)) {
    state.folders.push(dir);
    await api.saveFolders(state.folders);
    renderFolders();
    renderSettingsFolders();
    await refreshModels();
  }
});

el.settingsResetNotes.addEventListener('click', async () => {
  if (!window.confirm('确定清空所有标签和备注吗？此操作不可撤销（不会删除模型文件）。')) return;
  for (const p of Object.keys(state.notes)) {
    await api.saveNote(p, { tags: [], note: '' });
  }
  state.notes = {};
  renderModels();
  showToast('标签和备注已清空');
});

// ---- Menu events from main process ----
api.onMenu((evt) => {
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

// ---- Hugging Face downloader UI ----
async function doSearch() {
  const q = el.hfSearchInput.value.trim();
  if (!q) { showToast('请输入模型名称'); return; }
  const source = el.hfSourceSelect.value;
  const typeFilter = document.getElementById('hf-type-select').value;
  el.hfHint.innerHTML = '<p>搜索中...</p>';
  el.hfHint.classList.remove('hidden');
  el.hfResults.innerHTML = '';
  try {
    const r = await api.hfSearch(q, source, typeFilter);
    if (!r.ok) throw new Error(r.error);
    state.hfModels = r.models;
    state.hfSelected = null;
    el.hfHint.classList.add('hidden');
    renderHfResults();
  } catch (err) {
    el.hfHint.innerHTML = `<h2>搜索失败</h2><p>${esc(err.message || '请检查网络或切换数据源')}</p>`;
    el.hfHint.classList.remove('hidden');
  }
}

function renderHfResults() {
  el.hfResults.innerHTML = '';
  if (!state.hfModels.length) {
    el.hfHint.innerHTML = '<h2>没有找到模型</h2><p>换个关键词试试。</p>';
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

async function showHfFiles(m) {
  state.hfSelected = m;
  el.hfHint.classList.add('hidden');
  el.hfResults.innerHTML = '<div class="hf-files-wrap"><div class="hf-files-title">加载文件列表...</div></div>';
  try {
    const r = await api.hfFiles(m.id, m.source);
    if (!r.ok) throw new Error(r.error);
    const wrap = document.createElement('div');
    wrap.className = 'hf-files-wrap';
    wrap.innerHTML = `
      <div class="hf-files-title">
        <button class="hf-files-back">返回</button>
        <span>${esc(m.name)} 的文件 (${r.files.length})</span>
      </div>
      <div class="cmd-hint" style="margin-bottom:10px">模型文件排在前面。点击下载保存到设定目录，下载完自动出现在「全部模型」中。</div>
    `;
    wrap.querySelector('.hf-files-back').addEventListener('click', renderHfResults);
    if (!r.files.length) {
      wrap.innerHTML += '<div class="cmd-hint">这个仓库没有可下载的文件。</div>';
    }
    r.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'hf-file-row';
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
  return api.pickDownloadDir().then((dir) => {
    if (dir) {
      state.downloadDir = dir;
      el.downloadDirText.textContent = dir;
      el.downloadDirText.title = dir;
    }
    return dir;
  });
}

async function runDownload(task, d) {
  renderDownloadQueue();
  showToast('开始下载：' + d.name);
  const result = task.url ? await api.downloadUrl(task) : await api.downloadStart(task);
  const cur = state.downloads[task.id];
  if (!cur) return;
  if (result.ok) {
    cur.status = 'done';
    cur.loaded = cur.total || cur.loaded;
    if (result.skipped) showToast('文件已存在，跳过：' + d.name);
    else showToast('下载完成：' + d.name);
    if (!state.folders.includes(task.destDir)) {
      state.folders.push(task.destDir);
      await api.saveFolders(state.folders);
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
    const space = await api.checkDiskSpace(dir, file.size * 1.1); // 10% headroom
    if (space.ok && !space.enough) {
      showToast('磁盘空间不足，需要 ' + formatSize(file.size) + '，可用 ' + formatSize(space.free));
      return;
    }
  }
  const id = 'dl-' + (++state.downloadSeq) + '-' + Date.now();
  const task = { id, repoId: model.id, file, destDir: dir, sourceKey: model.source, kind: 'repo' };
  state.downloads[id] = {
    id, name: file.name, status: 'pending', loaded: 0, total: file.size || 0, speed: 0, task,
  };
  await runDownload(task, state.downloads[id]);
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
  await runDownload(task, state.downloads[id]);
}

function renderDownloadQueue() {
  const tasks = Object.values(state.downloads);
  const active = tasks.filter((d) => d.status === 'downloading' || d.status === 'pending' || d.status === 'paused').length;
  if (api.reportActiveDownloads) api.reportActiveDownloads(active);
  el.downloadCount.textContent = tasks.length;
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
        if (act === 'cancel') await api.downloadCancel(d.id);
        else if (act === 'pause') { await api.downloadPause(d.id); d.status = 'paused'; renderDownloadQueue(); }
        else if (act === 'resume') { await api.downloadResume(d.id); d.status = 'downloading'; renderDownloadQueue(); }
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
          await runDownload(newTask, nd);
        }
      });
    });
    el.downloadQueue.appendChild(item);
  });
}

api.onDownloadProgress((p) => {
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
  state.folders = await api.loadFolders();
  state.notes = await api.loadNotes();
  state.gpus = await api.getGpus();
  state.brands = await api.getBrands();
  renderGpuInfo();
  const btnRefreshGpu = document.getElementById('btn-refresh-gpu');
  if (btnRefreshGpu) {
    btnRefreshGpu.addEventListener('click', async () => {
      btnRefreshGpu.textContent = '检测中';
      state.gpus = await api.refreshGpus();
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
  renderDownloadQueue();
})();
