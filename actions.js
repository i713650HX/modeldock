// Computer-use tools for the local model.
//
// The model may *propose* a tool call in its answer. The renderer shows the
// call, then the main process decides what may run:
//   - read-only / launch actions run immediately
//   - script execution and file writes always show a native confirmation
//   - a small blocklist stops catastrophic commands even after confirmation
// There is no persistent shell session and no unrestrained command execution.
const { shell, dialog, clipboard, app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSoftware } = require('./software-catalog');
const { downloadFile } = require('./downloader');

const APP_ALIASES = {
  notepad: { label: '记事本', target: 'notepad.exe' },
  calc: { label: '计算器', target: 'calc.exe' },
  explorer: { label: '文件资源管理器', target: 'explorer.exe' },
  taskmgr: { label: '任务管理器', target: 'taskmgr.exe' },
  control: { label: '控制面板', target: 'control.exe' },
  settings: { label: '系统设置', target: 'ms-settings:' },
  mspaint: { label: '画图', target: 'mspaint.exe' },
  snippingtool: { label: '截图工具', target: 'snippingtool.exe' },
  chrome: { label: 'Chrome 浏览器', target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  edge: { label: 'Edge 浏览器', target: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  firefox: { label: 'Firefox 浏览器', target: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' },
  code: { label: 'VS Code', target: process.env.LOCALAPPDATA + '\\Programs\\Microsoft VS Code\\Code.exe' },
  cmd: { label: '命令提示符', target: 'cmd.exe' },
  powershell: { label: 'PowerShell', target: 'powershell.exe' },
};

const ACTION_LABELS = {
  open_app: '打开应用',
  open_url: '打开网页',
  open_path: '打开文件或文件夹',
  create_file: '创建文本文件',
  write_file: '写入文件',
  list_dir: '列出目录',
  read_file: '读取文件',
  system_info: '查看电脑配置',
  run_script: '运行 PowerShell 脚本',
  clipboard_write: '写入剪贴板',
  clipboard_read: '读取剪贴板',
};

// Actions that must show a confirmation dialog before doing anything.
// read_file / clipboard_read are included because their contents enter the
// chat context and could be sent out via a web search query.
const CONFIRM_KEYS = new Set([
  'run_script', 'write_file', 'create_file', 'download_software', 'read_file', 'clipboard_read',
]);

const MAX_SCRIPT_MS = 30000;
const MAX_OUTPUT_CHARS = 16000;
const MAX_READ_CHARS = 30000;

function launch(target, args) {
  if (/^ms-/.test(target)) return shell.openExternal(target);
  const child = spawn(target, args || [], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => { /* missing executable: caller already reports via alias list */ });
  child.unref();
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(1) + ' GB';
}

function systemInfoText() {
  const cpus = os.cpus();
  const cpu = cpus && cpus.length ? cpus[0].model.replace(/\s+/g, ' ').trim() : '未知';
  const total = (os.totalmem() / 1024 ** 3).toFixed(1);
  const free = (os.freemem() / 1024 ** 3).toFixed(1);
  const lines = [
    '系统：' + os.type() + ' ' + os.release(),
    '处理器：' + cpu + '（' + (cpus ? cpus.length : 0) + ' 线程）',
    '内存：' + total + ' GB，当前可用 ' + free + ' GB',
    '用户目录：' + os.homedir(),
  ];
  return lines.join('\n');
}

// Block the few commands that can destroy a machine or wipe user data.
// Everything else is allowed only after the user explicitly confirms.
function scriptBlockReason(script) {
  const s = String(script || '');
  // Normalize common evasions before matching:
  //   $env:USERPROFILE / $HOME / ~  -> C:\Users\...
  //   rm -r / del /s aliases        -> Remove-Item -Recurse
  //   string concat + quotes        -> removed
  const home = String(os.homedir() || 'C:\\Users').replace(/\\/g, '\\\\');
  let n = s
    .replace(/\$env:USERPROFILE\b/gi, home)
    .replace(/\$env:HOMEDRIVE\s*\+\s*\$env:HOMEPATH/gi, home)
    .replace(/\$home\b/gi, home)
    .replace(/(?<![\w])~(?![\w])/g, home)
    .replace(/\brm\b/gi, 'Remove-Item')
    .replace(/\bdel\b/gi, 'Remove-Item')
    .replace(/\brd\b/gi, 'Remove-Item')
    .replace(/-rf\b/gi, '-Recurse -Force')
    .replace(/-r\b/gi, '-Recurse')
    .replace(/-f\b/gi, '-Force')
    .replace(/(['"`])\s*\+\s*\1/g, '')      // 'a' + 'b' -> 'ab'
    .replace(/["'`]/g, '')                    // strip quotes
    .replace(/\s+/g, ' ');
  const rules = [
    [/\bformat-volume\b/i, '禁止格式化磁盘'],
    [/\bformat\s+[a-z]:/i, '禁止格式化磁盘'],
    [/\bdiskpart\b/i, '禁止 diskpart'],
    [/\bbcdedit\b/i, '禁止修改启动配置'],
    [/\b(shutdown|stop-computer|restart-computer)\b/i, '禁止关机或重启'],
    [/-enc(?:oded)?command/i, '禁止嵌套编码命令'],
    [/\[\s*scriptblock\]\s*::\s*create/i, '禁止动态脚本块'],
    [/invoke-expression|\biex\b|\birm\b|downloadstring/i, '禁止动态执行远程脚本'],
  ];
  for (const [re, reason] of rules) if (re.test(s) || re.test(n)) return reason;
  // Bulk-delete rules: any recursive removal targeting a drive root, the
  // Users tree, or the home directory is refused even after confirmation.
  if (/\bremove-item\b/i.test(n) && /-recurse/i.test(n)) {
    if (/[a-z]:\\/i.test(n)) return '禁止递归删除磁盘或用户目录';
    if (/\busers\b/i.test(n)) return '禁止递归删除用户目录';
    if (n.toLowerCase().includes(home.toLowerCase().replace(/\\\\/g, '\\'))) return '禁止递归删除用户目录';
  }
  if (/\bremove-item\b/i.test(n) && /-force\s+-recurse|-recurse\s+-force/i.test(n) && /[a-z]:\\/i.test(n)) {
    return '禁止强制递归删除磁盘目录';
  }
  return null;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    // Force UTF-8 output and silence non-interactive progress records, then
    // UTF-16LE encode the whole command to avoid quoting problems with Chinese.
    const wrapped = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + String(script || '');
    const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    let timer = null;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const trim = (v) => (v.length > MAX_OUTPUT_CHARS ? v.slice(0, MAX_OUTPUT_CHARS) + '\n（输出已截断）' : v);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        timedOut: !!timedOut,
        stdout: trim(out),
        stderr: trim(err),
      });
    };
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => {
      err += e.message;
      finish(-1, false);
    });
    child.on('close', (code) => finish(code, false));
    timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      finish(-1, true);
    }, MAX_SCRIPT_MS);
  });
}

async function confirmAction(key, param, mainWindow, scriptText) {
  const lines = [ACTION_LABELS[key] || key];
  if (key === 'run_script') {
    lines.push('', '模型请求运行以下 PowerShell 脚本：', '', scriptText.slice(0, 1400) || '(空脚本)');
    if (scriptText.length > 1400) lines.push('…（脚本过长，已截断显示）');
    lines.push('', '执行前请确认内容。脚本会在 30 秒后自动终止。');
  } else if (key === 'write_file' || key === 'create_file') {
    lines.push('', '目标：' + (param || '(未指定)'));
  } else if (key === 'download_software') {
    lines.push('', '将下载：' + (param || '(未指定)'));
  } else if (key === 'read_file') {
    lines.push('', '将读取文件：' + (param || '(未指定)'), '内容会进入对话上下文；若开启联网搜索，请不要把它写进搜索词。');
  } else if (key === 'clipboard_read') {
    lines.push('', '将读取剪贴板内容进入对话上下文。若开启联网搜索，请不要把它写进搜索词。');
  }
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['确认执行', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: 'ModelLodge · 操作确认',
    message: lines[0],
    detail: lines.slice(1).join('\n'),
  });
  return r.response === 0;
}

// Returns { ok, message, canceled?, info?, output? }. mainWindow is used for dialogs.
async function executeAction(key, rawParam, mainWindow, opts = {}) {
  const param = String(rawParam || '').trim();
  switch (key) {
    case 'open_app': {
      const hit = APP_ALIASES[param.toLowerCase()];
      if (!hit) {
        return { ok: false, error: '不支持打开「' + param + '」。可用：' + Object.keys(APP_ALIASES).join(', ') };
      }
      launch(hit.target);
      return { ok: true, message: '已打开' + hit.label };
    }
    case 'open_url': {
      if (!/^https?:\/\//i.test(param)) return { ok: false, error: '只能打开 http:// 或 https:// 开头的网址' };
      await shell.openExternal(param);
      return { ok: true, message: '已在浏览器打开：' + param };
    }
    case 'open_path': {
      if (!param) return { ok: false, error: '没有给出路径' };
      const err = await shell.openPath(param);
      return err ? { ok: false, error: err } : { ok: true, message: '已打开：' + param };
    }
    case 'list_dir': {
      const dir = param || os.homedir();
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        const lines = items.slice(0, 200).map((d) => {
          let size = '';
          try { size = d.isFile() ? '  ' + fmtBytes(fs.statSync(path.join(dir, d.name)).size) : ''; } catch (_) {}
          return (d.isDirectory() ? '[目录] ' : '[文件] ') + d.name + size;
        });
        if (items.length > 200) lines.push('…仅显示前 200 项，共 ' + items.length + ' 项');
        const out = lines.join('\n') || '(空目录)';
        return { ok: true, message: out, output: out };
      } catch (e) {
        return { ok: false, error: '无法列出目录：' + e.message };
      }
    }
    case 'read_file': {
      if (!param) return { ok: false, error: '没有给出文件路径' };
      if (!(await confirmAction('read_file', param, mainWindow))) return { ok: false, canceled: true };
      try {
        const st = fs.statSync(param);
        if (st.size > 4 * 1024 * 1024) return { ok: false, error: '文件超过 4MB，请先截取需要的部分' };
        let buf = fs.readFileSync(param);
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.slice(3);
        let text = buf.toString('utf8');
        let truncated = false;
        if (text.length > MAX_READ_CHARS) { text = text.slice(0, MAX_READ_CHARS); truncated = true; }
        return {
          ok: true,
          message: text + (truncated ? '\n（内容已截断）' : ''),
          output: text,
        };
      } catch (e) {
        return { ok: false, error: '无法读取文件：' + e.message };
      }
    }
    case 'create_file':
    case 'write_file': {
      if (!(await confirmAction(key, param, mainWindow))) return { ok: false, canceled: true };
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: key === 'write_file' ? '写入文件' : '保存文本文件',
        defaultPath: param || '新建文档.txt',
        filters: [
          { name: '文本文件', extensions: ['txt', 'md', 'csv', 'json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      try {
        fs.writeFileSync(filePath, opts.content || '', 'utf8');
        return { ok: true, message: '已写入：' + filePath };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'system_info': {
      const info = systemInfoText();
      return { ok: true, message: info, info };
    }
    case 'clipboard_write': {
      if (!param) return { ok: false, error: '没有给出要写入剪贴板的内容' };
      clipboard.writeText(param);
      return { ok: true, message: '已写入剪贴板（' + param.length + ' 字符）' };
    }
    case 'clipboard_read': {
      if (!(await confirmAction('clipboard_read', '', mainWindow))) return { ok: false, canceled: true };
      const text = clipboard.readText();
      return { ok: true, message: text || '(剪贴板为空)', output: text };
    }
    case 'download_software': {
      const sw = findSoftware(param);
      if (!sw) return { ok: false, error: '软件目录里没有「' + param + '」。可以说一个目录里的名字，或让我打开官网。' };
      // SECURITY: downloads from an AI-proposed action always require a native
      // confirmation. Do not bypass this by calling downloadFile elsewhere.
      if (!(await confirmAction('download_software', sw.name, mainWindow))) return { ok: false, canceled: true };
      const task = {
        id: 'sw-' + Date.now(),
        url: sw.url,
        fileName: sw.fileName,
        destDir: opts.downloadDir || app.getPath('downloads'),
        conflict: 'rename',
      };
      downloadFile(task, (progress) => {
        try {
          if (opts.onProgress) opts.onProgress(progress);
          else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', progress);
        } catch (_) {}
      }).then((result) => {
        try {
          if (opts.onDone) opts.onDone({ name: sw.name, ok: !!result.ok, path: result.path, error: result.error });
          else if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('software-download-done', { name: sw.name, ok: !!result.ok, path: result.path, error: result.error });
          }
        } catch (_) {}
      }).catch(() => {});
      return { ok: true, message: '已开始下载 ' + sw.name + '，完成后会提示你', software: sw.name };
    }
    case 'run_script': {
      const script = opts.script || param;
      if (!script || !script.trim()) return { ok: false, error: '脚本为空' };
      const reason = scriptBlockReason(script);
      if (reason) return { ok: false, error: reason + '，已拒绝执行' };
      if (!(await confirmAction('run_script', '', mainWindow, script))) return { ok: false, canceled: true };
      const res = await runPowerShell(script);
      let msg = '';
      if (res.timedOut) msg = '脚本执行超时（30 秒），已终止。\n';
      msg += (res.stdout || '').trim();
      if (res.stderr && res.stderr.trim()) msg += (msg ? '\n' : '') + '错误输出：\n' + res.stderr.trim();
      if (!msg) msg = res.ok ? '脚本执行完成，没有输出。' : '脚本执行失败，退出码 ' + res.exitCode;
      return { ok: res.ok || !!res.stdout.trim(), message: msg, output: msg, exitCode: res.exitCode };
    }
    default:
      return { ok: false, error: '未知动作：' + key };
  }
}

module.exports = {
  executeAction,
  ACTION_LABELS,
  APP_ALIASES,
  CONFIRM_KEYS,
  scriptBlockReason,
  runPowerShell,
};
