// Built-in inference engine manager.
//
// Backend priority for NVIDIA GPUs:
//   1. CUDA backend found on this machine (LM Studio extensions / manual llama.cpp)
//      — much faster than Vulkan on NVIDIA, uses the local CUDA runtime DLLs.
//   2. Bundled Vulkan backend — works offline on every GPU brand.
//   3. Bundled CPU fallback.
// For AMD / Intel GPUs the bundled Vulkan backend is preferred, then CPU.
//
// Everything talks to 127.0.0.1 only. Nothing leaves the machine.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ENGINE_DIR_NAME = 'llama';

// ---- locating the runtime -------------------------------------------------

function bundledEngineDir() {
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, ENGINE_DIR_NAME));
  try {
    const appPath = require('electron').app.getAppPath();
    roots.push(path.join(appPath, 'resources', ENGINE_DIR_NAME));
  } catch (e) { /* not in electron */ }
  roots.push(path.join(__dirname, 'resources', ENGINE_DIR_NAME));
  for (const r of roots) {
    try { if (fs.existsSync(path.join(r, 'llama-server.exe'))) return r; } catch (e) {}
  }
  return null;
}

// CUDA runtime DLLs (cublasLt/cublas/cudart) live next to the bundled CUDA
// backend, or in LM Studio's vendor package. Without them llama-server.exe
// exits with 0xC0000135 (STATUS_DLL_NOT_FOUND).
// CUDA runtime DLLs: cudart / cublas / cublasLt, version 12 or 13.
// Without them llama-server.exe exits with 0xC0000135 (STATUS_DLL_NOT_FOUND).
function hasCudaRuntime(dir) {
  if (!dir) return false;
  return [12, 13, 11].some((v) =>
    ['cudart64_' + v + '.dll', 'cublas64_' + v + '.dll', 'cublasLt64_' + v + '.dll']
      .some((f) => fs.existsSync(path.join(dir, f))));
}

function cudaVendorDirs() {
  // The installed component pack carries its own matching CUDA runtime DLLs.
  // If it is present, use ONLY that directory — never mix in LM Studio's
  // vendor folder. Two CUDA 12 vendor dirs in PATH can load mismatched DLLs
  // (0xC0000135 / silent crashes). Component pack wins, exclusively.
  const mine = installedCudaDir();
  if (mine && hasCudaRuntime(mine)) return [mine];

  const home = os.homedir();
  const roots = [];
  try {
    const locFile = path.join(home, '.lmstudio', '.internal', 'app-install-location.json');
    if (fs.existsSync(locFile)) {
      const j = JSON.parse(fs.readFileSync(locFile, 'utf8'));
      if (j && j.path) roots.push(path.dirname(j.path));
    }
  } catch (e) { /* ignore */ }
  roots.push(path.join(home, '.lmstudio', 'extensions', 'backends', 'vendor'));
  const out = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const walk = (dir, depth) => {
        if (depth > 3) return;
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          let st;
          try { st = fs.statSync(p); } catch (e) { continue; }
          if (!st.isDirectory()) continue;
          if (/cuda/i.test(name)) {
            if (hasCudaRuntime(p) && out.indexOf(p) === -1) out.push(p);
          }
          walk(p, depth + 1);
        }
      };
      walk(root, 0);
    } catch (e) { /* ignore */ }
  }
  return out;
}

// CUDA component pack installed into userData/cuda by the user (optional
// download). Legacy `resources/llama-cuda` is also accepted if present.
function installedCudaDir() {
  const roots = [];
  try {
    const { app } = require('electron');
    if (app && app.getPath) roots.push(path.join(app.getPath('userData'), 'cuda'));
  } catch (e) { /* not in electron */ }
  roots.push(path.join(os.homedir(), 'AppData', 'Roaming', 'modellodge', 'cuda'));
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'llama-cuda'));
  roots.push(path.join(__dirname, 'resources', 'llama-cuda'));
  for (const r of roots) {
    try {
      if (fs.existsSync(path.join(r, 'llama-server.exe')) && fs.existsSync(path.join(r, 'ggml-cuda.dll'))) return r;
    } catch (e) { /* ignore */ }
  }
  return null;
}

// CUDA-capable llama-server builds: installed component pack first, then
// backends already on this machine (LM Studio / manual llama.cpp).
function cudaCandidates() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [];
  const mine = installedCudaDir();
  if (mine) {
    return [{
      exe: path.join(mine, 'llama-server.exe'), dir: mine,
      label: 'CUDA · CUDA 组件包（已安装）', score: 10, bundled: true,
    }];
  }
  const addBackends = (root) => {
    if (!root) return;
    const p = path.join(root, '.lmstudio', 'extensions', 'backends');
    if (roots.indexOf(p) === -1) roots.push(p);
  };
  try {
    const locFile = path.join(home, '.lmstudio', '.internal', 'app-install-location.json');
    if (fs.existsSync(locFile)) {
      const j = JSON.parse(fs.readFileSync(locFile, 'utf8'));
      if (j && j.path) addBackends(path.dirname(j.path));
    }
  } catch (e) { /* ignore */ }
  addBackends(path.join(local, 'Programs', 'LM Studio'));
  addBackends(path.join(local, 'LM Studio'));
  roots.push(path.join(home, '.lmstudio', 'extensions', 'backends'));
  roots.push(path.join(home, 'llama.cpp', 'build', 'bin', 'Release'));

  const out = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const dir of fs.readdirSync(root)) {
        const p = path.join(root, dir, 'llama-server.exe');
        if (!fs.existsSync(p)) continue;
        const hasCuda = fs.existsSync(path.join(root, dir, 'ggml-cuda.dll'));
        if (!hasCuda) continue;
        // CUDA 12 builds are smaller and prefer newer drivers; rank them top.
        const l = dir.toLowerCase();
        const score = l.includes('cuda12') ? 3 : l.includes('cuda') ? 2 : 1;
        out.push({ exe: p, dir: path.join(root, dir), label: 'CUDA · ' + dir, score });
      }
    } catch (e) { /* ignore */ }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Third-party llama-server installs we can fall back to.
function externalEngineCandidates() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const out = [];
  const lmRoots = [];
  const addLmRoot = (root) => {
    if (!root) return;
    const backends = path.join(root, '.lmstudio', 'extensions', 'backends');
    if (lmRoots.indexOf(backends) === -1) lmRoots.push(backends);
  };
  try {
    const locFile = path.join(home, '.lmstudio', '.internal', 'app-install-location.json');
    if (fs.existsSync(locFile)) {
      const j = JSON.parse(fs.readFileSync(locFile, 'utf8'));
      if (j && j.path) addLmRoot(path.dirname(j.path));
    }
  } catch (e) { /* ignore */ }
  addLmRoot(path.join(local, 'Programs', 'LM Studio'));
  addLmRoot(path.join(local, 'LM Studio'));
  addLmRoot(path.join(home, 'AppData', 'Local', 'LM Studio'));

  for (const root of lmRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const dir of fs.readdirSync(root)) {
        const p = path.join(root, dir, 'llama-server.exe');
        if (fs.existsSync(p)) out.push({ path: p, label: 'LM Studio 后端 (' + dir + ')' });
      }
    } catch (e) { /* ignore */ }
  }
  const manual = [
    path.join(home, 'llama.cpp', 'build', 'bin', 'Release'),
    path.join(local, 'Programs', 'llama.cpp'),
  ];
  for (const dir of manual) {
    const p = path.join(dir, 'llama-server.exe');
    try { if (fs.existsSync(p)) out.push({ path: p, label: 'llama.cpp' }); } catch (e) {}
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'llama-server.exe');
    try { if (fs.existsSync(p)) out.push({ path: p, label: 'llama.cpp (PATH)' }); } catch (e) {}
  }
  return out;
}

// Quick check: is there an NVIDIA GPU, and which driver version is installed?
// One nvidia-smi call for both, cached for 30s. Driver version matters because
// CUDA 12 runtimes need >= 525.60.13 (and CUDA 12.8 wants >= 570).
let nvidiaCache = { at: 0, name: '', driver: null };
async function nvidiaInfo() {
  if (Date.now() - nvidiaCache.at < 30000) return nvidiaCache;
  let name = '', driver = null;
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve) => {
      execFile('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'],
        { timeout: 5000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : (stdout || '')));
    });
    const line = (out || '').split(/\r?\n/).find(Boolean) || '';
    const cols = line.split(',').map((s) => s.trim());
    name = cols[0] || '';
    const m = (cols[1] || '').match(/\d+\.\d+/);
    if (m) driver = m[0];
  } catch (e) { /* no nvidia-smi */ }
  nvidiaCache = { at: Date.now(), name, driver };
  return nvidiaCache;
}
async function hasNvidia() {
  const info = await nvidiaInfo();
  return /nvidia|geforce|rtx|quadro|tesla/i.test(info.name);
}
async function nvidiaDriverVersion() {
  return (await nvidiaInfo()).driver;
}
function driverMajor(version) {
  const m = String(version || '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
// CUDA 12 GA minimum is 525.60.13; the CUDA 12.8 runtime in our optional
// component pack wants 570+. Old drivers must not attempt CUDA 12 at all.
function cudaDriverWarning(version) {
  const major = driverMajor(version);
  if (!major) return null; // unknown driver: let the engine try, don't block
  if (major < 525) {
    return 'NVIDIA 驱动 ' + version + ' 过旧：CUDA 12 组件需要 525 以上（建议 570+），已回退 Vulkan / CPU';
  }
  if (major < 570) {
    return 'NVIDIA 驱动 ' + version + ' 可运行 CUDA 12，但建议升级到 570+ 以获得最佳兼容性';
  }
  return null;
}

// What can we actually run right now?
async function detectEngines() {
  const bundled = bundledEngineDir();
  const cuda = cudaCandidates();
  const nvidia = await hasNvidia();
  const driver = await nvidiaDriverVersion();
  const result = {
    bundled: null,
    vulkan: false,
    cuda: cuda.length ? cuda[0].dir : null,
    cudaCount: cuda.length,
    cudaBackends: cuda.map((c) => ({ dir: c.dir, label: c.label })),
    nvidia,
    driverVersion: driver,
    cudaDriverWarning: cudaDriverWarning(driver),
    external: [],
    source: null,
  };
  if (bundled) {
    result.bundled = bundled;
    result.vulkan = fs.existsSync(path.join(bundled, 'ggml-vulkan.dll'));
    result.source = 'bundled';
  }
  // Prefer the installed CUDA component pack in the summary too.
  const mine = installedCudaDir();
  if (mine && cuda.length && cuda[0].dir === mine) {
    result.cuda = mine;
    result.source = 'cuda-pack';
  }
  result.external = externalEngineCandidates();
  if (!result.bundled && result.external.length) result.source = 'external';
  return result;
}

// ---- running the engine ---------------------------------------------------

let running = null; // { proc, port, model, dir, backend, label }

const activeRequests = new Map();

function abortChat(reqId) {
  if (!reqId) return false;
  const req = activeRequests.get(reqId);
  if (!req) return false;
  activeRequests.delete(reqId);
  try { req.destroy(new Error('__ABORTED__')); } catch (e) { /* already closed */ }
  return true;
}

// Is a TCP port actually free? Avoids clashing with an external llama.cpp
// server on 8080, Ollama on 11434, LM Studio on 1234, or any other listener.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickPort() {
  const avoid = new Set([8080, 8090, 8098, 8099, 11434, 1234]);
  const start = 19000 + Math.floor(Math.random() * 400);
  for (let i = 0; i < 300; i++) {
    const p = start + i;
    if (avoid.has(p)) continue;
    if (await portFree(p)) return p;
  }
  // Last resort: OS-assigned ephemeral port.
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpGet(port, urlPath, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Choose the runtime. `preference` comes from settings: auto | cuda | vulkan | cpu.
async function pickEngine(preference, wantGpu) {
  const bundled = bundledEngineDir();
  const cuda = cudaCandidates();
  const nvidia = await hasNvidia();
  if (wantGpu && (preference === 'cuda' || (preference === 'auto' && nvidia && cuda.length))) {
    if (cuda.length) {
      // Refuse CUDA 12 on ancient drivers (<525) — it would fail to load
      // cublasLt/cudart with 0xC0000135. Fall through to Vulkan / CPU.
      const driverMajorNum = driverMajor(await nvidiaDriverVersion());
      if (!driverMajorNum || driverMajorNum >= 525) {
        const best = cuda[0];
        return {
          exe: best.exe,
          dir: best.dir,
          label: best.label,
          backend: 'cuda',
          accel: true,
          extraPath: cudaVendorDirs(),
        };
      }
    }
  }
  if (bundled) {
    const hasVulkan = fs.existsSync(path.join(bundled, 'ggml-vulkan.dll'));
    const useVulkan = wantGpu && hasVulkan && preference !== 'cpu';
    return {
      exe: path.join(bundled, 'llama-server.exe'),
      dir: bundled,
      label: useVulkan ? '内置引擎 (Vulkan 加速)' : '内置引擎 (CPU)',
      backend: useVulkan ? 'vulkan' : 'cpu',
      accel: useVulkan,
      extraPath: [],
    };
  }
  const external = externalEngineCandidates();
  if (external.length) {
    const score = (p) => {
      const s = p.toLowerCase();
      if (s.includes('cuda12')) return 5;
      if (s.includes('cuda')) return 4;
      if (s.includes('vulkan')) return 3;
      return 1;
    };
    const best = external.slice().sort((a, b) => score(b.path) - score(a.path))[0];
    return {
      exe: best.path, dir: path.dirname(best.path), label: best.label,
      backend: score(best.path) >= 4 ? 'cuda' : score(best.path) >= 3 ? 'vulkan' : 'cpu',
      accel: score(best.path) >= 3, extraPath: cudaVendorDirs(),
    };
  }
  return null;
}

// A CUDA out-of-memory failure. The exact wording varies between llama.cpp
// builds and CUDA versions, so match the stable parts of the message.
function isCudaOom(text) {
  return /cudaMalloc failed|out of memory|cudaErrorMemoryAllocation|std::bad_alloc|(?:failed|unable) to allocate[^\r\n]{0,80}buffer/i.test(String(text || ''));
}

// Conservative default context length. Use *free* VRAM when the caller has it
// (nvidia-smi), otherwise fall back to the card's total. A big KV cache on a
// 6 GB card is a classic source of lazy OOM on the first chat message.
function defaultContext(vramMB, freeMB) {
  const eff = (freeMB && freeMB > 0) ? Math.min(Number(vramMB) || 0, Number(freeMB)) : (Number(vramMB) || 0);
  if (!eff || eff < 2000) return 2048;
  if (eff < 4500) return 4096;
  if (eff < 8000) return 4096;
  if (eff < 12000) return 8192;
  return 8192;
}

// How many layers can be offloaded? Based on memory that is actually free,
// not the card's nominal size. Reserve room for KV cache + CUDA scratch, and
// only then compare against the full weight size.
function suggestGpuLayers(modelBytes, vramBytes, freeBytes) {
  const total = Number(vramBytes) || 0;
  const free = Number(freeBytes) || 0;
  if (!modelBytes || total <= 0) return 0;
  // If a live reading is available, trust it; otherwise use total minus a
  // larger safety margin for the desktop and other GPU apps.
  const budgetMB = free > 256 * 1024 ** 2
    ? (free - 1.4 * 1024 ** 3) / 1024 ** 2
    : (total - 2.2 * 1024 ** 3) / 1024 ** 2;
  if (budgetMB <= 0) return 0;
  const weightMB = modelBytes / 1024 ** 2;
  if (weightMB <= budgetMB) return 99;
  return Math.max(0, Math.min(99, Math.floor(budgetMB / weightMB * 99)));
}

const NGL_LADDER = [99, 75, 50, 35, 20, 8, 0];

function nextGpuLayers(current) {
  return NGL_LADDER.filter((n) => n < current).sort((a, b) => b - a)[0] ?? null;
}

// Start the engine on a model. Waits until /health answers.
//
// Warmup is deliberately NOT disabled: llama.cpp allocates its CUDA buffers
// during warmup, so an out-of-memory condition fails here where we can retry
// with fewer layers, instead of surfacing as a 500 on the first chat message.
async function startEngine(modelPath, opts = {}) {
  const preference = opts.backendPreference || 'auto';
  const attempt = Number(opts._attempt) || 0;
  const ctx = Number(opts.ctx) || 4096;
  const gpuLayers = Number(opts.gpuLayers) || 0;

  if (running) {
    if (running.model === modelPath && running.backend === preference) {
      return {
        ok: true, port: running.port, reused: true, backend: running.backend,
        label: running.label, gpuLayers: running.gpuLayers || 0, ctx: running.ctx || ctx,
      };
    }
    stopEngine();
  }

  const wantGpu = gpuLayers > 0;
  const pick = await pickEngine(preference, wantGpu);
  if (!pick) return { ok: false, error: '未找到推理引擎' };

  const port = await pickPort();
  const effectiveLayers = wantGpu && pick.accel ? gpuLayers : 0;
  const args = [
    '-m', modelPath,
    '--ctx-size', String(ctx),
    '--host', '127.0.0.1',
    '--port', String(port),
  ];
  // Always pass -ngl, including 0. llama.cpp defaults to 99 when omitted,
  // so leaving it out silently offloaded every layer even in CPU mode.
  args.push('-ngl', String(effectiveLayers));

  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete env[k];
  if (pick.extraPath && pick.extraPath.length) {
    env.PATH = pick.extraPath.concat(path.dirname(pick.exe), env.PATH || '').join(path.delimiter);
  }

  let proc;
  try {
    proc = spawn(pick.exe, args, {
      cwd: pick.dir, env, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: '引擎启动失败：' + e.message };
  }

  let log = '';
  const cap = (buf) => { log = (log + buf.toString()).slice(-6000); };
  proc.stdout.on('data', cap);
  proc.stderr.on('data', cap);
  proc.on('error', (e) => { log += '\n' + e.message; });

  // Retry a CUDA OOM by stepping down -ngl, then the context, then CPU.
  const fail = async (error) => {
    try { proc.kill(); } catch (e) {}
    if (isCudaOom(error) && attempt < 6) {
      let next = null;
      const lower = nextGpuLayers(gpuLayers);
      if (effectiveLayers > 0 && lower !== null) {
        // Big contexts inflate the KV cache; shrink both pressure sources.
        const smallerCtx = ctx > 4096 ? Math.max(4096, Math.floor(ctx / 2)) : ctx;
        next = { gpuLayers: lower, ctx: smallerCtx, backendPreference: preference };
      } else if (ctx > 2048) {
        const smaller = Math.max(2048, Math.floor(ctx / 2));
        next = { gpuLayers: 0, ctx: smaller, backendPreference: preference };
      } else if (preference !== 'cpu') {
        next = { gpuLayers: 0, ctx, backendPreference: 'cpu' };
      }
      if (next) {
        const retried = await startEngine(modelPath, { ...opts, ...next, _attempt: attempt + 1 });
        if (retried.ok) {
          // Report the FINAL settings, not just this step of the ladder.
          return { ...retried, message: '显存不足，已自动降级到 ' + (retried.gpuLayers || 0) + ' 层 / ' + (retried.ctx || ctx) + ' 上下文启动成功' };
        }
        return retried;
      }
    }
    return { ok: false, error, backend: pick.backend, gpuLayers: effectiveLayers, ctx };
  };

  const deadline = Date.now() + (opts.timeout || 180000);
  let lastErr = '';
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      return await fail('引擎进程已退出：\n' + (log.slice(-600) || '未知错误'));
    }
    try {
      const r = await httpGet(port, '/health', 1500);
      if (r.status === 200) {
        running = {
          proc, port, model: modelPath, dir: pick.dir, log,
          backend: pick.backend, label: pick.label, accel: pick.accel,
          gpuLayers: effectiveLayers, ctx,
        };
        return {
          ok: true, port, gpu: effectiveLayers > 0,
          backend: pick.backend, label: pick.label, gpuLayers: effectiveLayers, ctx,
        };
      }
    } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 800));
  }
  return await fail('引擎启动超时' + (lastErr ? '（' + lastErr + '）' : '') + '\n' + log.slice(-400));
}

function stopEngine() {
  if (!running) return { ok: true };
  try { running.proc.kill(); } catch (e) {}
  running = null;
  return { ok: true };
}

function engineStatus() {
  if (!running) return { running: false };
  return {
    running: true, port: running.port, model: running.model,
    backend: running.backend, label: running.label,
  };
}

// ---- chat ----------------------------------------------------------------

function streamChat(port, messages, onDelta, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqId = opts.reqId || '';
    let full = '';
    let reasoning = '';
    const payload = {
      model: 'local',
      messages,
      stream: true,
      temperature: opts.temperature != null ? opts.temperature : 0.7,
      max_tokens: opts.maxTokens || 2048,
    };
    // Qwen3 / DeepSeek-R1 style reasoning models think by default, which makes
    // a simple "你好" take ~2s with an empty bubble before any visible text.
    // Thinking OFF by default gives ~300ms first token. An explicit opt-in
    // (opts.thinking === true) keeps deep reasoning available. llama.cpp reads
    // this via the model's Jinja chat template.
    if (opts.thinking !== true) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { err += c; });
        res.on('end', () => reject(new Error('服务返回 HTTP ' + res.statusCode + (err ? '：' + err.slice(0, 300) : ''))));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const ch = j.choices && j.choices[0];
            const d = (ch && ch.delta) || {};
            // Reasoning models stream their "thinking" in reasoning_content.
            // Forward it separately so the UI can show it instead of an empty bubble.
            const think = d.reasoning_content || '';
            if (think) { reasoning += think; if (opts.onReasoning) opts.onReasoning(think); }
            const text = d.content || '';
            if (text) { full += text; if (onDelta) onDelta(text); }
          } catch (e) { /* ignore partial */ }
        }
      });
      res.on('end', () => { if (reqId) activeRequests.delete(reqId); resolve({ ok: true, content: full, reasoning }); });
      res.on('aborted', () => { if (reqId) activeRequests.delete(reqId); resolve({ ok: true, content: full, reasoning, aborted: true }); });
    });
    req.on('error', (err) => {
      if (reqId) activeRequests.delete(reqId);
      if (err && err.message === '__ABORTED__') return resolve({ ok: true, content: full, aborted: true });
      reject(err);
    });
    if (reqId) activeRequests.set(reqId, req);
    req.setTimeout(600000, () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

function vulkanInstalled() {
  const dir = bundledEngineDir();
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'ggml-vulkan.dll'));
}

module.exports = {
  detectEngines, startEngine, stopEngine, engineStatus, streamChat, abortChat,
  bundledEngineDir, installedCudaDir, vulkanInstalled, cudaCandidates, cudaVendorDirs,
  hasCudaRuntime, nvidiaDriverVersion, cudaDriverWarning, driverMajor,
  defaultContext, suggestGpuLayers, isCudaOom, nextGpuLayers,
  portFree, pickPort, hasNvidia, pickEngine,
};
