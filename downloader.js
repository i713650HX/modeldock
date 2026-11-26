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

function getJSON(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...authHeaders(hfToken, url) };
    const req = lib.get(url, { headers }, (res) => {
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
    const req = lib.request(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, url) } }, (res) => {
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
  // two modes: repo mode (repoId+file+sourceKey) or direct URL mode (url)
  let fileName, url;
  if (task.url) {
    url = task.url;
    fileName = task.fileName || fileNameFromUrl(url);
  } else {
    const { repoId, file, sourceKey } = task;
    fileName = file.name;
    url = formatUrl(repoId, file.path, sourceKey);
  }
  const destPath = path.join(destDir, fileName);
  const partPath = destPath + '.part'; // never expose incomplete downloads to the scanner
  const ctrl = { cancelled: false, paused: false, pauseResolvers: [], stream: null };
  activeDownloads.set(id, ctrl);

  // If a completed file already exists, verify its size before skipping.
  // A truncated/corrupt file must be re-downloaded, not silently trusted.
  if (fs.existsSync(destPath) && !fs.existsSync(partPath)) {
    const localSize = fs.statSync(destPath).size;
    const remoteSize = await headContentLength(url);
    if (remoteSize === null || localSize === remoteSize) {
      onProgress({ id, status: 'done', loaded: localSize, total: localSize, speed: 0 });
      return { ok: true, path: destPath, skipped: true };
    }
    // size mismatch — treat as corrupt and re-download
    try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
  }

  // Check existing partial file for resume
  let startByte = 0;
  let mode = 'w';
  if (fs.existsSync(partPath)) {
    const st = fs.statSync(partPath);
    if (st.size > 0) {
      startByte = st.size;
      mode = 'a';
    }
  }

  try {
    // ensure destination directory exists
    fs.mkdirSync(destDir, { recursive: true });
    const headers = { 'User-Agent': USER_AGENT, ...authHeaders(hfToken, url) };
    if (startByte > 0) headers.Range = 'bytes=' + startByte + '-';

    let res = await requestOnce(url, { headers });
    // If server ignores Range and returns 200, restart from scratch
    if (startByte > 0 && res.statusCode === 200) {
      startByte = 0;
      mode = 'w';
    } else if (res.statusCode === 416) {
      // range not satisfiable — partial file is already complete; finalize it
      res.resume();
      fs.renameSync(partPath, destPath);
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

    // Guard: partial file larger than the true total means the source changed — restart clean
    if (startByte > 0 && totalBytes > 0 && startByte >= totalBytes) {
      startByte = 0;
      mode = 'w';
      const res2 = await requestOnce(url, { headers: { 'User-Agent': USER_AGENT } });
      res.destroy();
      res = res2;
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        throw new Error('HTTP ' + res.statusCode);
      }
    }

    if (ctrl.cancelled) {
      res.destroy();
      return { ok: false, cancelled: true };
    }

    const stream = fs.createWriteStream(partPath, { flags: mode });
    ctrl.stream = res;
    let loaded = startByte;
    let lastReport = Date.now();
    let lastLoaded = startByte;

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // single reusable drain wait — avoids stacking listeners
      let drainWaiter = null;
      stream.on('drain', () => {
        if (drainWaiter) { const w = drainWaiter; drainWaiter = null; w(); }
      });
      const waitDrain = () => new Promise((r) => { drainWaiter = r; });

      res.on('data', async (chunk) => {
        if (ctrl.cancelled) {
          res.destroy();
          stream.destroy();
          return fail(new Error('cancelled'));
        }
        if (!stream.write(chunk)) {
          await waitDrain();
        }
        loaded += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 500) {
          const speed = Math.round((loaded - lastLoaded) / ((now - lastReport) / 1000));
          onProgress({
            id, status: 'downloading', loaded, total: totalBytes, speed,
          });
          lastReport = now;
          lastLoaded = loaded;
        }
      });
      res.on('end', () => { stream.end(done); });
      res.on('error', (e) => { stream.destroy(); fail(e); });
      stream.on('error', fail);
    });

    if (ctrl.cancelled) {
      return { ok: false, cancelled: true };
    }
    // finalize: rename .part -> final file (atomic on same volume)
    // stream may not have flushed yet — wait for finish
    if (!stream.writableFinished) {
      await new Promise((resolve) => stream.once('finish', resolve));
    }
    fs.renameSync(partPath, destPath);
    onProgress({ id, status: 'done', loaded, total: totalBytes, speed: 0 });
    return { ok: true, path: destPath };
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
  searchModels,
  getModelFiles,
  detectFileType,
  fileNameFromUrl,
  downloadFile,
  cancelDownload,
  pauseDownload,
  resumeDownload,
};
