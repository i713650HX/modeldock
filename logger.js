// Local-only crash/log system. NEVER uploads anything.
// Logs go to %APPDATA%\model-vault\logs\modelvault-YYYY-MM-DD.log
// Keeps the last 7 days of logs; older files are pruned on startup.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAX_LOG_FILES = 7;
const MAX_SIZE = 5 * 1024 * 1024; // rotate at 5MB

let currentDate = '';
let currentPath = '';

function ensureLogFile() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, fine for naming)
  if (date !== currentDate || !currentPath) {
    currentDate = date;
    currentPath = path.join(LOG_DIR, 'modelvault-' + date + '.log');
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      if (fs.existsSync(currentPath) && fs.statSync(currentPath).size > MAX_SIZE) {
        // append a rotated suffix instead of overwriting
        let i = 1;
        let rotated;
        do { rotated = currentPath.replace('.log', '-' + i + '.log'); i++; }
        while (fs.existsSync(rotated));
        fs.renameSync(currentPath, rotated);
      }
    } catch (e) { /* logging must never crash the app */ }
  }
  return currentPath;
}

function write(level, ...args) {
  try {
    const p = ensureLogFile();
    const ts = new Date().toISOString();
    const text = args.map((a) => {
      if (a instanceof Error) return (a.stack || a.message || String(a));
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }).join(' ');
    fs.appendFileSync(p, '[' + ts + '] [' + level + '] ' + text + '\n', 'utf8');
  } catch (e) { /* swallow — logging must be safe */ }
}

function pruneOldLogs() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => /^modelvault-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(f))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(MAX_LOG_FILES)) {
      try { fs.unlinkSync(path.join(LOG_DIR, f.name)); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function getLogDir() { return LOG_DIR; }

module.exports = {
  info: (...a) => write('INFO', ...a),
  warn: (...a) => write('WARN', ...a),
  error: (...a) => write('ERROR', ...a),
  crash: (...a) => write('CRASH', ...a),
  pruneOldLogs,
  getLogDir,
};
