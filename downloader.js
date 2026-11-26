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
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...authHeaders(hfToken, url) };
    const req = lib.get(url, { headers, agent: agentFor(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return getJSON(next, redirects + 1).then(resolve, reject);
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
  });
}

// Search ALL models (no format filter) — GGUF, safetensors, ONNX, anything.
async function searchModels(query, sourceKey, limit = 30, typeFilter = '') {
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
    source: sourceKey,
  }));
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
async function getModelFiles(repoId, sourceKey) {
  const src = SOURCES[sourceKey] || SOURCES.mirror;
  const url = src.api + '/api/models/' + repoId;
  const data = await getJSON(url);
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

function formatUrl(repoId, filePath, sourceKey) {
  const src = SOURCES[sourceKey] || SOURCES.mirror;
  return src.api + '/' + repoId + '/resolve/main/' + filePath.split('/').map(encodeURIComponent).join('/') + '?download=true';
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

// Guess a file name from a direct URL (handles signed URLs with query strings).
function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    let name = decodeURIComponent(path.basename(u.pathname));
    if (!name || name === '/' || !name.includes('.')) {
      // fall back to content-disposition or a generic name
      name = 'downloaded-file-' + Date.now();
    }
    // strip characters illegal on Windows
    return name.replace(/[<>:"|?*\\/]/g, '_');
  } catch (e) {
    return 'downloaded-file-' + Date.now();
  }
}

async function downloadFile(task, onProgress) {
  const { id, destDir } = task;
  let fileName, url;
  if (task.url) {
    url = task.url;
    fileName = task.fileName || fileNameFromUrl(url);
  } else {
    const { repoId, file, sourceKey } = task;
    fileName = file.name;
    url = formatUrl(repoId, file.path, sourceKey);
  }

  // Conflict policy: what to do if the final file already exists.
  // 'overwrite' | 'rename' | 'skip' (default: skip if valid, redownload if corrupt)
  const conflict = task.conflict || 'skip';
  const destPath0 = path.join(destDir, fileName);
  let destPath = destPath0;
  if (conflict === 'rename' && fs.existsSync(destPath0)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let i = 1;
    do { destPath = path.join(destDir, base + '-' + i + ext); i++; }
    while (fs.existsSync(destPath));
    fileName = path.basename(destPath);
  }
  const partPath = destPath + '.part';

  const ctrl = { cancelled: false, paused: false, pauseResolvers: [], stream: null };
  activeDownloads.set(id, ctrl);

  // Existing final file: verify size, then honor conflict policy.
  if (fs.existsSync(destPath) && !fs.existsSync(partPath)) {
    const localSize = fs.statSync(destPath).size;
    const remoteSize = await headContentLength(url);
    const valid = remoteSize === null || localSize === remoteSize;
    if (valid) {
      if (conflict === 'overwrite') {
        try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
      } else {
        onProgress({ id, status: 'done', loaded: localSize, total: localSize, speed: 0 });
        return { ok: true, path: destPath, skipped: true };
      }
    } else {
      // corrupt — always replace
      try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
    }
  }

  const MAX_STALL_RETRIES = 3;
  const STALL_MS = 8000;
  let stallRetries = 0;

  try {
    fs.mkdirSync(destDir, { recursive: true });

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
        onProgress({ id, status: 'done', loaded: fs.statSync(destPath).size, total: fs.statSync(destPath).size, speed: 0 });
        return { ok: true, path: destPath };
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
      } else if (task.file && task.file.size && task.file.size > 0) {
        totalBytes = task.file.size;
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
            onProgress({ id, status: 'downloading', loaded, total: totalBytes, speed, stalled: false });
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
          onProgress({ id, status: 'stalled', loaded, total: totalBytes, speed: 0, retry: attempt + 1, maxRetries: MAX_STALL_RETRIES });
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
          onProgress({ id, status: 'stalled', loaded: attemptResult.loaded, total: totalBytes, speed: 0, error: '连接持续停滞，已停止' });
          return { ok: false, error: 'download stalled after ' + MAX_STALL_RETRIES + ' retries' };
        }
        // loop continues: re-open from .part (resume)
        continue;
      }
      // success
      if (ctrl.cancelled) return { ok: false, cancelled: true };
      const loadedFinal = attemptResult.loaded;
      fs.renameSync(partPath, destPath);
      onProgress({ id, status: 'done', loaded: loadedFinal, total: totalBytes, speed: 0 });
      return { ok: true, path: destPath };
    }
    return { ok: false, error: 'download failed' };
  } finally {
    activeDownloads.delete(id);
  }
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

module.exports = {
  SOURCES,
  setHfToken,
  setProxy,
  testMirrorSpeed,
  searchModels,
  getModelFiles,
  detectFileType,
  fileNameFromUrl,
  downloadFile,
  cancelDownload,
  pauseDownload,
  resumeDownload,
};
