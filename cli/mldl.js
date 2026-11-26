#!/usr/bin/env node
// ModelLodge CLI - download and manage local models from the terminal.
// Shares the exact same downloader engine with the GUI app.
// Usage:
//   node mldl.js search <query> [source]
//   node mldl.js files <repo> [source]
//   node mldl.js get <repo> <file-path> [dest-dir] [source]
//   node mldl.js ls [dir]
//   node mldl.js sources
//   add --en anywhere for pure English output / 任意位置加 --en 输出纯英文

const dl = require('./downloader');
const fs = require('fs');
const path = require('path');

const rawArgs = process.argv.slice(2);
const EN = rawArgs.includes('--en');
// strip language flags
const args = rawArgs.filter(a => a !== '--en' && a !== '--zh');
const cmd = args.shift();

// Bilingual helper: Chinese primary, English annotation below (unless --en).
function say(zh, en) {
  if (EN) { console.log(en); return; }
  console.log(zh);
  if (en && en !== zh) console.log('   (' + en + ')');
}
function die(zh, en) {
  if (EN) console.error('Error: ' + (en || zh));
  else { console.error('错误：' + zh); if (en) console.error('   (Error: ' + en + ')'); }
  process.exit(1);
}

(async () => {
  switch (cmd) {
    case 'sources':
      say('可用的下载源：', 'Available sources:');
      Object.entries(dl.SOURCES).forEach(([k, v]) => console.log('  ' + k.padEnd(8) + ' ' + v.name));
      process.exit(0);
      break;

    case 'search': {
      const q = args[0];
      if (!q) die('用法：search <关键词> [源]', 'usage: search <query> [source]');
      const source = args[1] || 'mirror';
      say('正在「' + source + '」源搜索 "' + q + '" ...', 'Searching "' + q + '" on ' + source + '...');
      const models = await dl.searchModels(q, source, 20);
      if (!models.length) { say('没有找到结果。', 'No results.'); break; }
      models.forEach((m, i) => {
        console.log((i + 1) + '. ' + m.id + '  [' + (m.pipeline || '-') + ']  下载=' + m.downloads + '  喜欢=' + m.likes);
      });
      break;
    }

    case 'files': {
      const repo = args[0];
      if (!repo) die('用法：files <仓库> [源]', 'usage: files <repo> [source]');
      const source = args[1] || 'mirror';
      say('仓库 ' + repo + ' 的文件（源：' + source + '）：', 'Files in ' + repo + ' (' + source + '):');
      console.log('  * = 模型文件   [Q4_K_M 等] = 量化等级');
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
      if (!repo || !file) die('用法：get <仓库> <文件路径> [保存目录] [源]', 'usage: get <repo> <file-path> [dest-dir] [source]');
      const dest = destDir || process.cwd();
      const src = source || 'mirror';
      const fname = path.basename(file);
      say('正在从 ' + repo + ' 下载 ' + file + '\n   保存到：' + dest, 'Downloading ' + file + ' from ' + repo + ' -> ' + dest);
      let lastPct = -1;
      const result = await dl.downloadFile(
        { id: 'cli-' + Date.now(), repoId: repo, file: { name: fname, path: file }, destDir: dest, sourceKey: src },
        (p) => {
          if (p.status === 'downloading' && p.total > 0) {
            const pct = Math.floor(p.loaded / p.total * 100);
            if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write('\r  进度 ' + pct + '%  (' + (p.speed / 1024 / 1024).toFixed(1) + ' MB/s)'); }
          } else if (p.status === 'stalled') {
            process.stdout.write('\r  连接停滞，重试 ' + (p.retry || '?') + '   ');
          }
        }
      );
      process.stdout.write('\n');
      if (result.ok) say('完成：' + result.path + (result.skipped ? '（已存在，跳过）' : ''), 'Done: ' + result.path + (result.skipped ? ' (skipped, already existed)' : ''));
      else die(result.error || '下载失败', result.error || 'download failed');
      break;
    }

    case 'ls': {
      const dir = args[0] || process.cwd();
      if (!fs.existsSync(dir)) die('目录不存在：' + dir, 'directory not found: ' + dir);
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
      say('目录 ' + dir + ' 下的模型：', 'Models under ' + dir + ':');
      walk(dir, 0);
      break;
    }

    default:
      say('ModelLodge 命令行工具 v1.0', 'ModelLodge CLI v1.0');
      if (!EN) console.log('（以下命令中 <> 为必填，[] 为可选；在任意位置加 --en 可切换为纯英文输出）\n');
      console.log('  search <关键词> [源]                 搜索模型      / Search models');
      console.log('  files <仓库> [源]                    列出仓库文件  / List repo files');
      console.log('  get <仓库> <文件路径> [目录] [源]     下载文件      / Download a file');
      console.log('  ls [目录]                            列出本地模型  / List local models');
      console.log('  sources                              列出可用源    / List sources');
  }
})().catch(e => die(e.message, e.message));
