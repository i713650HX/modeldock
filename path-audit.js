// Regression: bundled/CUDA engines must load GGUF files from paths that
// contain Chinese characters and spaces (a classic llama.cpp failure mode).
const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('./engine');

(async () => {
  const source = path.join(process.env.TEMP || os.tmpdir(), 'modellodge-e2e-dl', 'TinyLlama-1.1B-Chat-v1.0-Q2_K.gguf');
  if (!fs.existsSync(source)) { console.log('SKIP: test model missing'); return; }
  const dir = path.join(os.tmpdir(), '模型 测试 目录');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'TinyLlama 量化 Q2_K.gguf');
  if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(source).size) {
    fs.copyFileSync(source, target);
  }
  console.log('MODEL_PATH', target);

  const det = await engine.detectEngines();
  console.log('CUDA_AVAILABLE', det.cudaCount, 'NVIDIA', det.nvidia);

  for (const pref of det.cudaCount ? ['cuda', 'cpu'] : ['cpu']) {
    const r = await engine.startEngine(target, {
      ctx: 1024,
      gpuLayers: pref === 'cuda' ? 20 : 0,
      backendPreference: pref,
      timeout: 120000,
    });
    console.log('START', pref, JSON.stringify(r));
    if (!r.ok) continue;
    const c = await engine.streamChat(r.port, [{ role: 'user', content: 'Reply with the single word OK.' }], null, { maxTokens: 16, temperature: 0 });
    console.log('CHAT', pref, c.ok, JSON.stringify((c.content || '').slice(0, 80)));
    engine.stopEngine();
  }
  console.log('PATH_AUDIT_DONE');
})().catch((e) => { console.error('PATH_AUDIT_FAIL', e.stack || e.message); process.exit(1); });
