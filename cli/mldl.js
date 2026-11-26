#!/usr/bin/env node
// ModelLodge CLI - download and manage local models from the terminal.
// Shares the exact same downloader engine with the GUI app.
// Usage:
//   node mldl.js search <query> [source]
//   node mldl.js files <repo> [source]
//   node mldl.js get <repo> <file-path> [dest-dir] [source]
//   node mldl.js ls [dir]
//   node mldl.js sources
// Output is English for Windows console safety.

const dl = require('./downloader');
const fs = require('fs');
const path = require('path');

const [cmd, ...args] = process.argv.slice(2);

function die(msg) { console.error('Error: ' + msg); process.exit(1); }

(async () => {
  switch (cmd) {
    case 'sources':
      console.log('Available sources:');
      Object.entries(dl.SOURCES).forEach(([k, v]) => console.log('  ' + k.padEnd(8) + ' ' + v.name));
      process.exit(0);
      break;

    case 'search': {
      const q = args[0];
      if (!q) die('usage: search <query> [source]');
      const source = args[1] || 'mirror';
      console.log('Searching "' + q + '" on ' + source + '...');
      const models = await dl.searchModels(q, source, 20);
      if (!models.length) { console.log('No results.'); break; }
      models.forEach((m, i) => {
        console.log((i + 1) + '. ' + m.id + '  [' + (m.pipeline || '-') + ']  downloads=' + m.downloads + '  likes=' + m.likes);
      });
      break;
    }

    case 'files': {
      const repo = args[0];
      if (!repo) die('usage: files <repo> [source]');
      const source = args[1] || 'mirror';
      console.log('Files in ' + repo + ' (' + source + '):');
      const files = await dl.getModelFiles(repo, source);
      files.forEach(f => {
        const size = f.size ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : '?';
        const q = f.quant ? ' [' + f.quant + ']' : '';
        console.log('  ' + (f.isModel ? '*' : ' ') + ' ' + f.path + q + '  ' + size);
      });
      break;
    }

    case 'get': {
      const [repo, file, destDir, source] = args;
      if (!repo || !file) die('usage: get <repo> <file-path> [dest-dir] [source]');
      const dest = destDir || process.cwd();
      const src = source || 'mirror';
      const fname = path.basename(file);
      console.log('Downloading ' + file + ' from ' + repo + ' -> ' + dest);
      let lastPct = -1;
      const result = await dl.downloadFile(
        { id: 'cli-' + Date.now(), repoId: repo, file: { name: fname, path: file }, destDir: dest, sourceKey: src },
        (p) => {
          if (p.status === 'downloading' && p.total > 0) {
            const pct = Math.floor(p.loaded / p.total * 100);
            if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write('\r  ' + pct + '%  (' + (p.speed / 1024 / 1024).toFixed(1) + ' MB/s)'); }
          } else if (p.status === 'stalled') {
            process.stdout.write('\r  stalled, retry ' + (p.retry || '?') + '   ');
          }
        }
      );
      process.stdout.write('\n');
      if (result.ok) console.log('Done: ' + result.path + (result.skipped ? ' (skipped, already existed)' : ''));
      else die(result.error || 'download failed');
      break;
    }

    case 'ls': {
      const dir = args[0] || process.cwd();
      if (!fs.existsSync(dir)) die('directory not found: ' + dir);
      const exts = /\.(gguf|safetensors|bin|pt|pth|onnx|ckpt|h5|pb|tflite|npz|ggml)$/i;
      function walk(d, depth) {
        if (depth > 4) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && !e.name.startsWith('.')) walk(p, depth + 1);
          else if (e.isFile() && exts.test(e.name)) {
            const st = fs.statSync(p);
            console.log('  ' + (st.size / 1024 / 1024 / 1024).toFixed(2) + ' GB  ' + p);
          }
        }
      }
      console.log('Models under ' + dir + ':');
      walk(dir, 0);
      break;
    }

    default:
      console.log('ModelLodge CLI v1.0');
      console.log('  search <query> [source]                 Search models');
      console.log('  files <repo> [source]                   List repo files');
      console.log('  get <repo> <file-path> [dest] [source]  Download a file');
      console.log('  ls [dir]                                List local models');
      console.log('  sources                                 List sources');
  }
})().catch(e => die(e.message));
