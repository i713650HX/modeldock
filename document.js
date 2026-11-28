// Local document-to-text conversion. All parsing happens on this machine;
// no file content ever leaves the app except into the local model prompt.
const fs = require('fs');
const path = require('path');

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_DOC_CHARS = 32000;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'mdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql',
  'html', 'htm', 'css', 'scss', 'vue', 'svelte', 'gradle', 'dockerfile',
]);

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function parsePdf(filePath) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(fs.readFileSync(filePath));
  return data.text || '';
}

async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

function parseSpreadsheet(filePath, ext) {
  if (ext === '.csv' || ext === '.tsv') return fs.readFileSync(filePath, 'utf8');
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const parts = [];
  wb.SheetNames.forEach((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
    parts.push('【工作表：' + name + '】');
    rows.slice(0, 3000).forEach((row) => {
      parts.push(Array.from(row).map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'));
    });
  });
  return parts.join('\n');
}

function parsePptx(filePath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const slides = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
  if (!slides.length) return '';
  const parts = [];
  slides.forEach((entry, i) => {
    const xml = entry.getData().toString('utf8');
    // DrawingML stores every visible text run inside <a:t>.
    const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) => decodeXml(m[1]));
    if (texts.length) parts.push('【幻灯片 ' + (i + 1) + '】\n' + texts.join('\n'));
  });
  return parts.join('\n\n');
}

// Returns { ok, name, type, text, truncated } or { ok:false, error }.
async function parseDocument(filePath) {
  const name = path.basename(filePath || '');
  const ext = path.extname(filePath || '').toLowerCase();
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: '这不是一个文件' };
    if (st.size > MAX_DOC_BYTES) return { ok: false, error: '文件超过 25MB，请先拆分后再附加' };
    if (st.size === 0) return { ok: false, error: '文件是空的' };

    let text = '';
    if (ext === '.pdf') {
      text = await parsePdf(filePath);
    } else if (ext === '.docx') {
      text = await parseDocx(filePath);
    } else if (['.xlsx', '.xls', '.csv', '.tsv'].includes(ext)) {
      text = parseSpreadsheet(filePath, ext);
    } else if (ext === '.pptx') {
      text = parsePptx(filePath);
    } else if (TEXT_EXTS.has(ext.slice(1))) {
      let buf = fs.readFileSync(filePath);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.slice(3);
      text = buf.toString('utf8');
    } else {
      return { ok: false, error: '暂不支持 ' + (ext || '无扩展名') + '，请另存为 PDF / Word / Excel / PPT / 文本' };
    }

    text = String(text || '').trim();
    if (!text) return { ok: false, error: '没有从文件里提取到文字（扫描版 PDF 需要先 OCR）' };
    const truncated = text.length > MAX_DOC_CHARS;
    if (truncated) text = text.slice(0, MAX_DOC_CHARS);
    return { ok: true, name, type: ext.slice(1) || 'txt', text, truncated };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { parseDocument, TEXT_EXTS, MAX_DOC_BYTES, MAX_DOC_CHARS };
