// Local-only crash/log system. NEVER uploads anything.
// Logs go to %APPDATA%\modellodge\logs\modellodge-YYYY-MM-DD.log
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
    currentPath = path.join(LOG_DIR, 'modellodge-' + date + '.log');
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

// Buffer writes and flush once per second: appendFileSync on every log line
// blocks the main thread during heavy downloads. Errors are always flushed immediately.
let buffer = [];
let flushTimer = null;
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buffer.length) return;
  const lines = buffer;
  buffer = [];
  try {
    fs.appendFileSync(ensureLogFile(), lines.join(''), 'utf8');
  } catch (e) { /* swallow — logging must be safe */ }
}
function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

function write(level, ...args) {
  try {
    const ts = new Date().toISOString();
    const text = args.map((a) => {
      if (a instanceof Error) return (a.stack || a.message || String(a));
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }).join(' ');
    const line = '[' + ts + '] [' + level + '] ' + text + '\n';
    // Critical entries go straight to disk; routine info is batched.
    if (level === 'ERROR' || level === 'CRASH') {
      buffer.push(line);
      flush();
    } else {
      buffer.push(line);
      scheduleFlush();
    }
  } catch (e) { /* swallow — logging must be safe */ }
}

function pruneOldLogs() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => /^modellodge-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(f))
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
  flush,
};
