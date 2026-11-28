// Model search (Hugging Face / mirror) + universal file downloader.
// Supports any model format (GGUF, safetensors, ONNX, zip...) and arbitrary direct URLs.
// Uses Node https directly — no extra npm dependency.
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const SOURCES = {
  hf: { name: 'Hugging Face', api: 'https://huggingface.co', web: 'https://huggingface.co' },
  mirror: { name: 'HF 镜像 (国内)', api: 'https://hf-mirror.com', web: 'https://hf-mirror.com' },
  ms: { name: 'ModelScope 魔搭', api: 'https://www.modelscope.cn', web: 'https://www.modelscope.cn' },
};

const USER_AGENT = 'ModelLodge/1.0 (+local-model-manager)';

// Auth header helper: only send the token to the configured HF hosts,
// never forward it to CDN redirects (security).
function authHeaders(token, url) {
  const h = {};
  if (!token) return h;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'huggingface.co' || host.endsWith('.huggingface.co') ||
        host === 'hf-mirror.com' || host.endsWith('.hf-mirror.com')) {
      h.Authorization = 'Bearer ' + token;
    }
  } catch (e) { /* ignore invalid URL */ }
  return h;
}

// global token (set by main process from encrypted storage)
let hfToken = '';
function setHfToken(token) { hfToken = token || ''; }

// ---- Proxy support (HTTP/HTTPS, e.g. http://127.0.0.1:7890) ----
// Uses https-proxy-agent (declared production dependency). Agent is attached
// to every HTTP(S) request so downloads/metadata/search all respect it.
let proxyUrl = '';
let HttpsProxyAgent = null;
function setProxy(url) {
  proxyUrl = (url || '').trim();
  if (!proxyUrl) return;
  try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; }
  catch (e) { HttpsProxyAgent = null; }
}
function agentFor(url) {
  if (!proxyUrl || !HttpsProxyAgent) return undefined;
  // never proxy localhost
  try { if (new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost') return undefined; }
  catch (e) { /* ignore */ }
  return new HttpsProxyAgent(proxyUrl);
}

// ---- Mirror speed test (HEAD request timing) ----
async function testMirrorSpeed(sourceKey) {
  const src = SOURCES[sourceKey] || SOURCES.mirror;
  const testUrl = src.api + '/api/models?limit=1';
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ms, ok) => { if (done) return; done = true; resolve({ source: sourceKey, ms, ok }); };
    const lib = testUrl.startsWith('https:') ? https : http;
    const req = lib.get(testUrl, {
      headers: { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, testUrl) },
      agent: agentFor(testUrl),
    }, (res) => { res.resume(); finish(Date.now() - t0, res.statusCode === 200); });
    req.on('error', () => finish(Date.now() - t0, false));
    req.setTimeout(8000, () => { req.destroy(); finish(8000, false); });
  });
}

function getJSON(url, redirects = 0) {
  return requestJSON('GET', url, null, redirects);
}

// Generic JSON request (GET / PUT / POST) with automatic retry on
// transient network failures (the CN mirrors time out fairly often).
async function requestJSON(method, url, bodyObj, redirects = 0, attempt = 0) {
  try {
    return await requestJSONOnce(method, url, bodyObj, redirects);
  } catch (err) {
    const retriable = err && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED' || err.code === 'EPIPE' || err.code === 'EAI_AGAIN' ||
      /timeout|socket hang up/i.test(err.message || ''));
    if (retriable && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return requestJSON(method, url, bodyObj, redirects, attempt + 1);
    }
    throw err;
  }
}

function requestJSONOnce(method, url, bodyObj, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...authHeaders(hfToken, url) };
    let body = null;
    if (bodyObj) {
      body = JSON.stringify(bodyObj);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(url, { method, headers, agent: agentFor(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return requestJSON(method, next, bodyObj, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ---- ModelScope search (public PUT endpoint, no login required) ----
// POST/PUT /api/v1/dolphin/models  ->  { Code, Data:{ Model:{ Models:[...] } } }
async function searchModelScope(query, limit = 30) {
  const url = SOURCES.ms.api + '/api/v1/dolphin/models';
  const data = await requestJSON('PUT', url, {
    PageSize: Math.min(limit, 50),
    PageNumber: 1,
    Query: query,
    SortBy: 'Default',
    Target: '',
    SingleCriterion: [],
    PageSizeByCaller: limit,
  });
  const models = (data && data.Data && data.Data.Model && data.Data.Model.Models) || [];
  return models.map((m) => ({
    id: (m.Path ? m.Path + '/' : '') + m.Name,
    author: m.Path || '',
    name: m.Name,
    downloads: m.Downloads || 0,
    likes: m.Stars || 0,
    tags: (m.Tags || []).slice(0, 12),
    pipeline: (m.Tasks && m.Tasks[0] && m.Tasks[0].Name) || null,
    lastModified: m.LastUpdatedTime ? new Date(m.LastUpdatedTime * 1000).toISOString() : null,
    description: m.Description || '',
    private: false,
    source: 'ms',
  }));
}

// Search ALL models (no format filter) — GGUF, safetensors, ONNX, anything.
async function searchModels(query, sourceKey, limit = 30, typeFilter = '') {
  if (sourceKey === 'ms') return searchModelScope(query, limit);
  const src = SOURCES[sourceKey] || SOURCES.mirror;
  const params = { search: query, limit: String(limit), full: 'false' };
  // optional HF filter: gguf | safetensors | onnx ... or empty for everything
  if (typeFilter) params.filter = typeFilter;
  const url = src.api + '/api/models?' + new URLSearchParams(params);
  const data = await getJSON(url);
  if (!Array.isArray(data)) return [];
  return data.map((m) => ({
    id: m.id || m._id,
    author: (m.id || '').split('/')[0],
    name: (m.id || '').split('/').pop(),
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    tags: (m.tags || []).filter((t) => !t.startsWith('license:')),
    pipeline: m.pipeline_tag || null,
    lastModified: m.lastModified || null,
    private: m.private || false,
    // HF gated repos (Llama / Gemma / etc.) need an accepted licence + Token.
    // We keep them marked instead of pretending ModelScope has the same repo.
    gated: !!m.gated,
    source: sourceKey,
  }));
}

// ---- Model detail page (LM-Studio style: description / params / README) ----
// HF: GET /api/models/{id}?blobs=true  -> gguf{ total, architecture, context_length }, cardData, siblings
// MS: GET /api/v1/models/{ns}/{name}  -> meta
//
// The detail endpoint and the file-list endpoint hit the same HF URL, so we
// cache the raw payload for a short window and serve both from it.
const repoCache = new Map(); // key -> { at, data }
const REPO_CACHE_MS = 30000;

async function fetchRepoPayload(repoId, sourceKey) {
  const key = sourceKey + '|' + repoId;
  const hit = repoCache.get(key);
  if (hit && Date.now() - hit.at < REPO_CACHE_MS) return hit.data;
  const src = SOURCES[sourceKey] || SOURCES.mirror;
  const data = await getJSON(src.api + '/api/models/' + repoId + '?blobs=true');
  repoCache.set(key, { at: Date.now(), data });
  return data;
}

async function getModelDetail(repoId, sourceKey, revision) {
  if (sourceKey === 'ms') return getModelScopeDetail(repoId, revision);
  const data = await fetchRepoPayload(repoId, sourceKey);
  const gguf = data.gguf || {};
  return {
    id: data.id || repoId,
    author: (data.id || repoId).split('/')[0],
    name: (data.id || repoId).split('/').pop(),
    downloads: data.downloads || 0,
    likes: data.likes || 0,
    lastModified: data.lastModified || null,
    gated: !!data.gated,
    tags: (data.tags || []).filter((t) => !t.startsWith('license:')),
    license: (data.cardData && data.cardData.license) || null,
    baseModel: (data.cardData && data.cardData.base_model) || null,
    description: buildDescriptionFromCard(data.cardData),
    // gguf metadata from the API — no need to download the file to know these
    paramBytes: gguf.total || null,
    architecture: gguf.architecture || null,
    contextLength: gguf.context_length || null,
    totalSize: data.usedStorage || null,
    source: sourceKey,
  };
}

function buildDescriptionFromCard(cardData) {
  if (!cardData) return '';
  const parts = [];
  if (cardData.base_model) parts.push('Base model: ' + cardData.base_model);
  if (cardData.license) parts.push('License: ' + cardData.license);
  if (cardData.language) parts.push('Language: ' + [].concat(cardData.language).join(', '));
  if (cardData.pipeline_tag) parts.push('Task: ' + cardData.pipeline_tag);
  return parts.join(' · ');
}

async function getModelScopeDetail(repoId, revision) {
  const rev = (revision || 'master').replace(/[^a-zA-Z0-9._\-]/g, '');
  const data = await getJSON(SOURCES.ms.api + '/api/v1/models/' + repoId);
  const d = (data && data.Data) || {};
  return {
    id: repoId,
    author: repoId.split('/')[0],
    name: repoId.split('/').pop(),
    downloads: d.Downloads || 0,
    likes: d.Stars || 0,
    lastModified: d.LastUpdatedTime ? new Date(d.LastUpdatedTime * 1000).toISOString() : null,
    gated: false,
    tags: d.Tags || [],
    license: d.License || null,
    baseModel: (d.BaseModel && d.BaseModel[0]) || null,
    description: d.Description || '',
    paramBytes: null,
    architecture: null,
    contextLength: null,
    totalSize: null,
    source: 'ms',
    revision: rev,
  };
}

// Read README (raw markdown) for a model repo.
async function getReadme(repoId, sourceKey, revision) {
  try {
    if (sourceKey === 'ms') {
      const rev = (revision || 'master').replace(/[^a-zA-Z0-9._\-]/g, '');
      const url = SOURCES.ms.api + '/api/v1/models/' + repoId + '/repo?Revision=' + encodeURIComponent(rev) + '&FilePath=README.md';
      const data = await getJSON(url);
      const content = data && data.Data && (data.Data.Content || data.Data.content);
      return typeof content === 'string' ? content : '';
    }
    const src = SOURCES[sourceKey] || SOURCES.mirror;
    const rev = revision || 'main';
    const url = src.api + '/' + repoId + '/raw/' + rev + '/README.md';
    const text = await getText(url);
    return text || '';
  } catch (e) {
    return '';
  }
}

// Raw text GET helper (with retry on transient network failures)
async function getText(url, redirects = 0) {
  try {
    return await getTextOnce(url, redirects);
  } catch (err) {
    const retriable = err && (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' ||
      err.code === 'EPIPE' || err.code === 'EAI_AGAIN' || /timeout|socket hang up/i.test(err.message || ''));
    if (retriable && redirects < 4) {
      await new Promise((r) => setTimeout(r, 500 * (redirects + 1)));
      return getText(url, redirects + 1);
    }
    throw err;
  }
}

function getTextOnce(url, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, url) };
    const req = lib.get(url, { headers, agent: agentFor(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return getText(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
  });
}

// Get ALL files for a repo (not just gguf). Detect type from extension.
function detectFileType(fname) {
  const ext = (fname.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const map = {
    gguf: 'GGUF', safetensors: 'SafeTensors', bin: 'BIN', pt: 'PyTorch',
    pth: 'PyTorch', onnx: 'ONNX', ckpt: 'Checkpoint', h5: 'Keras',
    pb: 'TensorFlow', tflite: 'TFLite', npz: 'NumPy', zip: 'ZIP',
    tar: 'TAR', gz: 'GZip', json: 'JSON', py: 'Python', md: '文档',
    pdf: 'PDF', txt: '文本', jinja: '模板',
  };
  if (map[ext]) return map[ext];
  if (!ext) return '文件';
  return ext.toUpperCase();
}

// Get all files for a repo, with smart sorting (model files first, then by size).
async function getModelFiles(repoId, sourceKey, revision) {
  if (sourceKey === 'ms') return getModelScopeFiles(repoId, revision);
  // blobs=true gives us real file sizes -> we can show accurate download sizes
  // before the user clicks, exactly like LM Studio's "Download Options".
  const data = await fetchRepoPayload(repoId, sourceKey);
  const siblings = data.siblings || [];
  // model-like extensions get priority
  const modelExts = /\.(gguf|safetensors|bin|pt|pth|onnx|ckpt|h5|pb|tflite|npz|zip|tar|gz)$/i;
  const files = siblings
    .filter((s) => !s.rfilename.startsWith('.') && !s.rfilename.includes('/.'))
    .map((s) => {
      const fname = path.basename(s.rfilename);
      let quant = null;
      const qm = fname.match(/(iq\d[\w_]*|q\d[\w_]*|fp16|fp32|bf16|f16|f32)/i);
      if (qm) quant = qm[1].toUpperCase();
      return {
        name: fname,
        path: s.rfilename,
        size: s.size || null,
        quant,
        type: detectFileType(fname),
        isModel: modelExts.test(fname),
        dir: path.dirname(s.rfilename),
      };
    });
  // model files first, then others; within each group keep original order
  return [
    ...files.filter((f) => f.isModel),
    ...files.filter((f) => !f.isModel),
  ];
}

// ---- Download engine ----
const activeDownloads = new Map(); // id -> { cancelled, paused, ... }

function formatUrl(repoId, filePath, sourceKey, revision) {
  const src = SOURCES[sourceKey] || SOURCES.mirror;
  const rev = (revision || (sourceKey === 'ms' ? 'master' : 'main')).replace(/[^a-zA-Z0-9._\-\/]/g, '');
  if (sourceKey === 'ms') {
    return src.api + '/models/' + repoId + '/resolve/' + rev + '/' + filePath.split('/').map(encodeURIComponent).join('/');
  }
  return src.api + '/' + repoId + '/resolve/' + rev + '/' + filePath.split('/').map(encodeURIComponent).join('/') + '?download=true';
}

// ModelScope file list: GET /api/v1/models/{ns}/{name}/repo/files?Revision=master
async function getModelScopeFiles(repoId, revision) {
  const rev = (revision || 'master').replace(/[^a-zA-Z0-9._\-]/g, '');
  const url = SOURCES.ms.api + '/api/v1/models/' + repoId + '/repo/files?Revision=' + encodeURIComponent(rev);
  const data = await getJSON(url);
  const raw = (data.Data && data.Data.Files) || [];
  const modelExts = /\.(gguf|safetensors|bin|pt|pth|onnx|ckpt|h5|pb|tflite|npz|zip|tar|gz)$/i;
  return raw
    .filter(f => f.Path && !f.Path.startsWith('.'))
    .map(f => {
      const fname = path.basename(f.Path);
      let quant = null;
      const qm = fname.match(/(iq\d[\w_]*|q\d[\w_]*|fp16|fp32|bf16|f16|f32)/i);
      if (qm) quant = qm[1].toUpperCase();
      const size = f.Size ? parseInt(f.Size, 10) : null;
      return { name: fname, path: f.Path, size: isFinite(size) ? size : null, quant,
        type: detectFileType(fname), isModel: modelExts.test(fname), dir: path.dirname(f.Path) };
    })
    .sort((a, b) => (b.isModel - a.isModel));
}

function requestOnce(url, opts, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      agent: agentFor(url),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        // Security: strip Authorization when leaving HF hosts (redirect to CDN)
        const nextOpts = { ...opts, headers: { ...opts.headers } };
        if (nextOpts.headers.Authorization && !authHeaders(hfToken, next).Authorization) {
          delete nextOpts.headers.Authorization;
        }
        return requestOnce(next, nextOpts, redirects + 1).then(resolve, reject);
      }
      resolve(res);
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// HEAD request to learn remote file size (follows redirects, no body download).
function headContentLength(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 8) return resolve(null);
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, url) }, agent: agentFor(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return headContentLength(next, redirects + 1).then(resolve);
      }
      res.resume();
      const len = parseInt(res.headers['content-length'], 10);
      resolve(isFinite(len) && len > 0 ? len : null);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => req.destroy());
    req.end();
  });
}

// SECURITY: normalize every file name before it touches the filesystem.
// Only ASCII word chars, dots, dashes, spaces and CJK ideographs are kept.
// Windows device names, leading dots and trailing dots/spaces are rejected.
function safeFileName(raw) {
  let name = String(raw == null ? '' : raw).replace(/\\/g, '/');
  try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
  name = name.split('/').filter(Boolean).pop() || '';
  name = name.replace(/[^\w.\- \u4e00-\u9fff]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 180);
  const stem = name.split('.')[0].toUpperCase();
  if (!name || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return 'downloaded-file-' + Date.now();
  }
  return name;
}

// Return a path that is guaranteed to stay inside destDir, or null.
function containedPath(destDir, fileName) {
  const full = path.resolve(destDir, fileName);
  const rel = path.relative(path.resolve(destDir), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

// Guess a file name from a direct URL (handles signed URLs with query strings).
function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    let name = decodeURIComponent(path.basename(u.pathname));
    if (!name || name === '/' || !name.includes('.')) {
      // fall back to a generic name
      name = 'downloaded-file-' + Date.now();
    }
    return safeFileName(name);
  } catch (e) {
    return 'downloaded-file-' + Date.now();
  }
}

async function downloadFile(task, onProgress) {
  const { id, destDir } = task;
  const entries = buildDownloadEntries(task);
  if (!entries.length) return { ok: false, error: '没有可下载的文件' };

  const conflict = task.conflict || 'skip';

  // Resolve final destination for every entry (rename policy needs the whole set).
  const planned = entries.map((e) => {
    // SECURITY: sanitize remote file names and verify containment before any write.
    const fileName = safeFileName(e.fileName);
    let destPath = containedPath(destDir, fileName);
    if (!destPath) {
      return { ...e, invalidName: true, destPath: path.join(destDir, 'downloaded-file-' + Date.now()), partPath: '' };
    }
    if (conflict === 'rename' && fs.existsSync(destPath)) {
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      let i = 1;
      do {
        destPath = containedPath(destDir, base + '-' + i + ext);
        if (!destPath) return { ...e, invalidName: true, destPath: path.join(destDir, 'downloaded-file-' + Date.now()), partPath: '' };
        i++;
      }
      while (fs.existsSync(destPath));
    }
    return { ...e, fileName, destPath, partPath: destPath + '.part' };
  });
  const badEntries = planned.filter((p) => p.invalidName);
  if (badEntries.length) return { ok: false, error: '下载文件名不安全，已拒绝写入：' + badEntries[0].fileName };

  // Total size for the whole group (used for the shared progress bar).
  let groupTotal = planned.reduce((s, p) => s + (p.size || 0), 0);
  if (!groupTotal) groupTotal = planned.length;

  const ctrl = { cancelled: false, paused: false, pauseResolvers: [], stream: null };
  activeDownloads.set(id, ctrl);

  let groupLoaded = 0;
  // addLoaded accumulates bytes across all files of the group.
  const addLoaded = (delta) => { groupLoaded += (delta || 0); };

  try {
    fs.mkdirSync(destDir, { recursive: true });

    for (const p of planned) {
      if (ctrl.cancelled) return { ok: false, cancelled: true };
      const res = await downloadOneFile(p, ctrl, conflict, (loaded, total, speed) => {
        onProgress({ id, status: 'downloading', loaded: groupLoaded + loaded, total: groupTotal || total, speed, stalled: false });
      }, addLoaded);
      if (!res.ok) return res;
    }

    onProgress({ id, status: 'done', loaded: groupTotal, total: groupTotal, speed: 0 });
    return { ok: true, path: planned[0].destPath, files: planned.map((p) => p.destPath) };
  } finally {
    activeDownloads.delete(id);
  }
}

// Build the list of concrete files to fetch for a task.
function buildDownloadEntries(task) {
  if (task.url) {
    return [{ fileName: task.fileName || fileNameFromUrl(task.url), url: task.url, size: task.size || 0 }];
  }
  if (Array.isArray(task.files) && task.files.length) {
    return task.files.map((f) => ({
      fileName: f.name,
      url: formatUrl(task.repoId, f.path, task.sourceKey, task.revision),
      size: f.size || 0,
      file: f,
    }));
  }
  if (task.file) {
    return [{
      fileName: task.file.name,
      url: formatUrl(task.repoId, task.file.path, task.sourceKey, task.revision),
      size: task.file.size || 0,
      file: task.file,
    }];
  }
  return [];
}

// Download one file with resume / stall-retry; returns { ok, cancelled }.
async function downloadOneFile(p, ctrl, conflict, onProgress, setBase) {  // setBase(delta) adds bytes
  const MAX_STALL_RETRIES = 3;
  const STALL_MS = 8000;
  const destPath = p.destPath;
  const partPath = p.partPath;
  const url = p.url;

  // Existing final file: verify size, then honor conflict policy.
  if (fs.existsSync(destPath) && !fs.existsSync(partPath)) {
    const localSize = fs.statSync(destPath).size;
    const remoteSize = await headContentLength(url);
    const valid = remoteSize === null || localSize === remoteSize;
    if (valid) {
      if (conflict === 'overwrite') {
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
      } else {
        setBase(localSize);
        onProgress(localSize, localSize, 0);
        return { ok: true, skipped: true };
      }
    } else {
      try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
    }
  }

  let stallRetries = 0;
  for (let attempt = 0; attempt <= MAX_STALL_RETRIES; attempt++) {
    if (ctrl.cancelled) return { ok: false, cancelled: true };

    // Re-check partial size each attempt (resume from where we stopped)
    let startByte = 0;
    let mode = 'w';
    if (fs.existsSync(partPath)) {
      const st = fs.statSync(partPath);
      if (st.size > 0) { startByte = st.size; mode = 'a'; }
    }

    const headers = { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, url) };
    if (startByte > 0) headers.Range = 'bytes=' + startByte + '-';

    let res = await requestOnce(url, { headers });
    if (startByte > 0 && res.statusCode === 200) { startByte = 0; mode = 'w'; }
    else if (res.statusCode === 416) {
      res.resume();
      if (fs.existsSync(partPath)) fs.renameSync(partPath, destPath);
      const sz = fs.statSync(destPath).size;
      setBase(sz);
      onProgress(sz, sz, 0);
      return { ok: true };
    } else if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      throw new Error('HTTP ' + res.statusCode);
    }

    const total = startByte + (parseInt(res.headers['content-length'], 10) || 0);
    const contentRange = res.headers['content-range'];
    let totalBytes = total;
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)/);
      if (m) totalBytes = parseInt(m[1], 10);
    } else if (p.size && p.size > 0) {
      totalBytes = p.size;
    }

    if (startByte > 0 && totalBytes > 0 && startByte >= totalBytes) {
      startByte = 0; mode = 'w';
      res.destroy();
      const res2 = await requestOnce(url, { headers: { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, url) } });
      res = res2;
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume(); throw new Error('HTTP ' + res.statusCode);
      }
    }

    // Stream this attempt. Watchdog rejects with STALL marker on no progress.
    const attemptResult = await new Promise((resolve) => {
      let resolved = false;
      const finish = (kind, extra) => {
        if (resolved) return;
        resolved = true;
        if (watchdog) clearInterval(watchdog);
        resolve({ kind, ...extra });
      };
      const stream = fs.createWriteStream(partPath, { flags: mode });
      ctrl.stream = res;
      let loaded = startByte;
      let lastReport = Date.now();
      let lastLoaded = startByte;
      let lastDataAt = Date.now();
      let drainWaiter = null;

      stream.on('drain', () => { if (drainWaiter) { const w = drainWaiter; drainWaiter = null; w(); } });
      const waitDrain = () => new Promise((r) => { drainWaiter = r; });

      res.on('data', async (chunk) => {
        if (ctrl.cancelled) { res.destroy(); stream.destroy(); return finish('cancel'); }
        lastDataAt = Date.now();
        if (!stream.write(chunk)) await waitDrain();
        loaded += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 500) {
          const speed = Math.round((loaded - lastLoaded) / ((now - lastReport) / 1000));
          onProgress(loaded, totalBytes, speed);
          lastReport = now; lastLoaded = loaded;
        }
      });
      res.on('end', () => { stream.end(() => finish('ok', { loaded })); });
      res.on('error', (e) => { try { stream.destroy(); } catch (_) {} finish('error', { error: e }); });
      stream.on('error', (e) => finish('error', { error: e }));

      // watchdog: no bytes for STALL_MS => destroy this attempt, mark stalled
      const watchdog = setInterval(() => {
        if (ctrl.cancelled) return;
        if (Date.now() - lastDataAt < STALL_MS) return;
        onProgress(loaded, totalBytes, 0);
        res.destroy();
        try { stream.destroy(); } catch (_) {}
        finish('stall', { loaded });
      }, 2000);
    });

    if (attemptResult.kind === 'cancel') return { ok: false, cancelled: true };
    if (attemptResult.kind === 'error') throw attemptResult.error;
    if (attemptResult.kind === 'stall') {
      stallRetries = attempt + 1;
      if (stallRetries > MAX_STALL_RETRIES) {
        return { ok: false, error: 'download stalled after ' + MAX_STALL_RETRIES + ' retries' };
      }
      continue; // loop continues: re-open from .part (resume)
    }
    // success
    if (ctrl.cancelled) return { ok: false, cancelled: true };
    fs.renameSync(partPath, destPath);
    setBase(attemptResult.loaded);
    return { ok: true };
  }
  return { ok: false, error: 'download failed' };
}

function cancelDownload(id) {
  const ctrl = activeDownloads.get(id);
  if (ctrl) {
    ctrl.cancelled = true;
    ctrl.paused = false;
    ctrl.pauseResolvers.forEach((r) => r());
    ctrl.pauseResolvers = [];
    return true;
  }
  return false;
}

function pauseDownload(id) {
  const ctrl = activeDownloads.get(id);
  if (ctrl) {
    ctrl.paused = true;
    if (ctrl.stream && typeof ctrl.stream.pause === 'function') ctrl.stream.pause();
    return true;
  }
  return false;
}

function resumeDownload(id) {
  const ctrl = activeDownloads.get(id);
  if (ctrl) {
    ctrl.paused = false;
    if (ctrl.stream && typeof ctrl.stream.resume === 'function') ctrl.stream.resume();
    ctrl.pauseResolvers.forEach((r) => r());
    ctrl.pauseResolvers = [];
    return true;
  }
  return false;
}

// ---- Download options: group a repo's files into per-quantization choices ----
// LM Studio shows one clickable row per quantization (Q4_K_M / Q5_K_M / Q8_0 ...),
// each row downloading every shard of that quantization.
const QUANT_RE = /(iq\d[\w_]*|q\d[\w_]*|fp16|fp32|bf16|f16|f32)/i;
const QUANT_LABELS = {
  'IQ1_S': 'IQ1_S（极致压缩）', 'IQ1_M': 'IQ1_M', 'IQ2_XXS': 'IQ2_XXS', 'IQ2_XS': 'IQ2_XS', 'IQ2_S': 'IQ2_S',
  'IQ2_M': 'IQ2_M', 'IQ3_XXS': 'IQ3_XXS', 'IQ3_S': 'IQ3_S', 'IQ3_M': 'IQ3_M',
  'Q2_K': 'Q2_K', 'Q3_K_S': 'Q3_K_S', 'Q3_K_M': 'Q3_K_M', 'Q3_K_L': 'Q3_K_L',
  'Q4_0': 'Q4_0', 'Q4_1': 'Q4_1', 'Q4_K_S': 'Q4_K_S', 'Q4_K_M': 'Q4_K_M（均衡，推荐）',
  'Q5_0': 'Q5_0', 'Q5_1': 'Q5_1', 'Q5_K_S': 'Q5_K_S', 'Q5_K_M': 'Q5_K_M（高质量）',
  'Q6_K': 'Q6_K', 'Q8_0': 'Q8_0（接近无损）', 'FP16': 'FP16', 'FP32': 'FP32', 'BF16': 'BF16',
};
const QUANT_RANK = {
  IQ1_S: 1, IQ1_M: 2, IQ2_XXS: 3, IQ2_XS: 4, IQ2_S: 5, IQ2_M: 6,
  IQ3_XXS: 7, IQ3_S: 8, IQ3_M: 9, Q2_K: 10, Q3_K_S: 11, Q3_K_M: 12, Q3_K_L: 13,
  Q4_0: 14, Q4_1: 15, Q4_K_S: 16, Q4_K_M: 17, Q5_0: 18, Q5_1: 19,
  Q5_K_S: 20, Q5_K_M: 21, Q6_K: 22, Q8_0: 23, BF16: 24, FP16: 25, FP32: 26,
};

// A shard filename looks like "<base>-00001-of-00003.gguf".
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

function detectQuant(name) {
  const m = String(name).match(QUANT_RE);
  return m ? m[1].toUpperCase().replace(/_/g, '_') : null;
}

function quantLabel(q) {
  if (!q) return '其它';
  return QUANT_LABELS[q] || q;
}

// Group repo files into download options: one per quantization, shards merged.
// Repos often ship BOTH a split file (name-00001-of-00002.gguf) and a merged
// copy (name.gguf). We prefer the merged single file when it exists.
function buildDownloadOptions(files) {
  const ggufFiles = (files || []).filter((f) => /\.(gguf)$/i.test(f.path || f.name));
  const otherFiles = [];

  // bucket by quantization
  const buckets = new Map(); // quant -> { quant, files[], shardFiles[], plainFiles[] }
  ggufFiles.forEach((f) => {
    const full = String(f.path || f.name);
    const isShard = SHARD_RE.test(full);
    const quant = (f.quant || detectQuant(f.name) || 'OTHER').toUpperCase();
    if (!buckets.has(quant)) buckets.set(quant, { quant, shardFiles: [], plainFiles: [] });
    if (isShard) buckets.get(quant).shardFiles.push(f);
    else buckets.get(quant).plainFiles.push(f);
  });

  const options = [];
  for (const b of buckets.values()) {
    let chosen = [], shardCount = 0;
    if (b.plainFiles.length) {
      // prefer a merged single file (largest one if several)
      chosen = [b.plainFiles.slice().sort((x, y) => (y.size || 0) - (x.size || 0))[0]];
      shardCount = 1;
    } else {
      chosen = b.shardFiles.slice().sort((x, y) => String(x.path).localeCompare(String(y.path)));
      const m0 = String(chosen[0] ? chosen[0].path : '').match(SHARD_RE);
      shardCount = m0 ? parseInt(m0[3], 10) : chosen.length;
    }
    if (!chosen.length) continue;
    const totalSize = chosen.reduce((s, f) => s + (f.size || 0), 0);
    options.push({
      key: 'q:' + b.quant,
      quant: b.quant === 'OTHER' ? null : b.quant,
      label: quantLabel(b.quant === 'OTHER' ? null : b.quant),
      fileName: chosen[0].name,
      filePath: chosen[0].path,
      shardCount,
      totalSize: totalSize || chosen[0].size || 0,
      files: chosen,
    });
  }

  (files || []).filter((f) => !/\.gguf$/i.test(f.path || f.name)).forEach((f) => otherFiles.push(f));

  // Sort: GGUF options by quantization quality, then by size.
  options.sort((a, b) => {
    const ra = QUANT_RANK[a.quant] || 99;
    const rb = QUANT_RANK[b.quant] || 99;
    if (ra !== rb) return ra - rb;
    return (a.totalSize || 0) - (b.totalSize || 0);
  });

  return { options, otherFiles };
}

module.exports = {
  SOURCES,
  setHfToken,
  setProxy,
  testMirrorSpeed,
  searchModels,
  searchModelScope,
  getModelFiles,
  getModelDetail,
  getReadme,
  buildDownloadOptions,
  detectFileType,
  fileNameFromUrl,
  safeFileName,
  containedPath,
  downloadFile,
  cancelDownload,
  pauseDownload,
  resumeDownload,
};
