// GPU VRAM detection + model fit assessment.
// Strategy:
//   1. nvidia-smi  -> exact VRAM for NVIDIA GPUs (WMI truncates >4GB to 32-bit!)
//   2. PowerShell CIM registry -> QWORD VRAM for all GPUs (AMD/Intel/NVIDIA)
//   3. WMI AdapterRAM -> fallback (unreliable above 4GB, flagged)
const { execFile, exec } = require('child_process');
const { detectBrand, isIntegrated } = require('./brands');

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeout || 8000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function runShell(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeout || 10000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// Query NVIDIA GPUs via nvidia-smi (most accurate)
async function detectNVIDIA() {
  const out = await run('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.used,memory.free',
    '--format=csv,noheader,nounits',
  ], 8000);
  if (!out) return [];
  const gpus = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 5) continue;
    const totalMB = parseFloat(parts[2]);
    if (!isFinite(totalMB) || totalMB <= 0) continue;
    gpus.push({
      name: parts[1],
      vendor: 'NVIDIA',
      brand: detectBrand(parts[1]),
      vramBytes: Math.round(totalMB * 1024 * 1024),
      vramMB: Math.round(totalMB),
      usedMB: parseFloat(parts[3]) || 0,
      freeMB: parseFloat(parts[4]) || 0,
      source: 'nvidia-smi',
      reliable: true,
    });
  }
  return gpus;
}

// Query all GPUs via PowerShell (registry QWORD, handles >4GB correctly)
async function detectAllCIM() {
  const ps = `
    $class = '{4d36e968-e325-11ce-bfc1-08002be10318}'
    $base = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\$class"
    Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
      $p = $_.PSChildName
      if ($p -match '^\\d{4}$') {
        $path = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\$class\\$p"
        $name = (Get-ItemProperty -Path $path -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc
        $mem = (Get-ItemProperty -Path $path -Name HardwareInformation.qwMemorySize -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
        if ($name -and $mem) {
          [PSCustomObject]@{ Name = $name; Vram = [uint64]$mem } | ConvertTo-Json -Compress
        }
      }
    }
  `;
  const out = await runShell('powershell.exe -NoProfile -NonInteractive -Command "' + ps.replace(/"/g, '\\"').replace(/\n/g, ' ') + '"', 12000);
  if (!out) return [];
  const gpus = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const o = JSON.parse(s);
      const vram = Number(o.Vram);
      if (!isFinite(vram) || vram <= 0) continue;
      gpus.push({
        name: o.Name,
        vendor: detectBrand(o.Name).short,
        brand: detectBrand(o.Name),
        vramBytes: vram,
        vramMB: Math.round(vram / 1024 / 1024),
        usedMB: null,
        freeMB: null,
        source: 'registry-qword',
        reliable: true,
      });
    } catch (e) { /* skip */ }
  }
  return gpus;
}

// Fallback: WMI AdapterRAM (32-bit truncated, unreliable >4GB)
async function detectWMI() {
  const ps = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress";
  const out = await runShell('powershell.exe -NoProfile -NonInteractive -Command "' + ps + '"', 10000);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out.trim());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter((o) => o.AdapterRAM > 0).map((o) => ({
      name: o.Name,
      vendor: detectBrand(o.Name).short,
      brand: detectBrand(o.Name),
      vramBytes: Number(o.AdapterRAM),
      vramMB: Math.round(o.AdapterRAM / 1024 / 1024),
      usedMB: null,
      freeMB: null,
      source: 'wmi',
      reliable: false,
    }));
  } catch (e) {
    return [];
  }
}

// Main detection: query ALL sources, merge by name with best (most reliable) value winning.
// This ensures every brand — NVIDIA, AMD, Intel — shows up with its own VRAM figure.
async function detectGPUs() {
  let gpus = [];
  try {
    const [nv, cim, wmi] = await Promise.all([
      detectNVIDIA(),
      detectAllCIM(),
      detectWMI(),
    ]);

    // reliability priority: nvidia-smi (3) > registry QWORD (2) > WMI (1)
    const priority = { 'nvidia-smi': 3, 'registry-qword': 2, wmi: 1 };
    const byName = new Map();

    const add = (g) => {
      if (!g || !g.name) return;
      // normalize name for dedup (case-insensitive, trim)
      const key = g.name.toLowerCase().replace(/\s+/g, ' ').trim();
      const existing = byName.get(key);
      g.integrated = isIntegrated(g.name);
      if (!existing || priority[g.source] > priority[existing.source]) {
        byName.set(key, g);
      }
    };

    nv.forEach(add);
    cim.forEach(add);
    wmi.forEach(add);

    gpus = [...byName.values()];
    // sort: discrete GPUs first (NVIDIA/AMD), then integrated; within group by VRAM desc
    gpus.sort((a, b) => {
      if (a.integrated !== b.integrated) return a.integrated ? 1 : -1;
      return b.vramBytes - a.vramBytes;
    });
  } catch (e) {
    gpus = [];
  }
  return gpus;
}

// Assessment rules:
//   modelBytes <= usable*0.92          -> 充足 (comfortably fits)
//   usable*0.92 < modelBytes <= usable*1.4  -> 稍不足 (tight / partial offload possible)
//   modelBytes > usable*1.4            -> 完全不足 (won't fit)
// "usable" = VRAM minus a small reserve for system/display (~0.6GB if >4GB, else 0.3GB)
function assessFit(modelBytes, gpu) {
  if (!gpu || !gpu.vramBytes || !modelBytes) {
    return { level: 'unknown', label: '未知', detail: '无法判断', ratio: null };
  }
  const reserve = gpu.vramBytes > 4 * 1024**3 ? 0.6 * 1024**3 : 0.3 * 1024**3;
  const usable = Math.max(0.5 * 1024**3, gpu.vramBytes - reserve);
  const ratio = modelBytes / usable;
  let level, label, detail;
  if (ratio <= 0.92) {
    level = 'good';
    label = '显存充足';
    detail = '模型可完整载入显存';
  } else if (ratio <= 1.4) {
    level = 'tight';
    label = '显存稍不足';
    detail = '勉强可运行，可能需要部分卸载到内存';
  } else {
    level = 'bad';
    label = '显存完全不足';
    detail = '超出显存太多，无法直接载入';
  }
  return { level, label, detail, ratio: Math.round(ratio * 100) / 100, usableBytes: Math.round(usable) };
}

module.exports = { detectGPUs, assessFit, detectBrand, isIntegrated };
