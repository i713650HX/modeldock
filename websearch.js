// Web search for ModelLodge chat — optional, off by default.
// Uses Bing (no API key, reachable in mainland China via cn.bing.com). Two
// result formats are used: the HTML result page (rich snippets + dates) as the
// primary source, and the RSS endpoint as a fallback. Queries are rewritten
// from conversational questions into search-engine friendly keywords.
// Nothing is cached to disk and no query is logged: the only network egress is
// the user's explicit search query sent to Bing when the toggle is on.
const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 ModelLodge/2.4';
const CURRENT_YEAR = new Date().getFullYear();

// Sources in priority order. cn.bing.com is the domestic endpoint and is much
// more reliable from mainland China; www.bing.com is the fallback.
const SOURCES = [
  { key: 'cn', host: 'cn.bing.com', kind: 'bing' },
  { key: 'www', host: 'www.bing.com', kind: 'bing' },
  // Only reached when both Bing endpoints fail. DuckDuckGo's HTML endpoint
  // needs no key and often works where Bing's layout changed.
  { key: 'ddg', host: 'html.duckduckgo.com', kind: 'ddg' },
];

let proxyUrl = '';
let HttpsProxyAgent = null;
function setProxy(url) {
  proxyUrl = (url || '').trim();
  if (!proxyUrl) return;
  try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; }
  catch (e) { HttpsProxyAgent = null; }
}
function agentFor(url) {
  if (!proxyUrl || !HttpsProxyAgent) return undefined;
  try {
    const h = new URL(url).hostname;
    if (h === '127.0.0.1' || h === 'localhost') return undefined;
  } catch (e) { /* ignore */ }
  return new HttpsProxyAgent(proxyUrl);
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/rss+xml,application/xml,text/xml,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      agent: agentFor(url),
    }, (res) => {
      // Follow redirects (Bing sometimes 302s to a regional host).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (next === url) return reject(new Error('重定向循环'));
        return resolve(httpGet(next, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 3 * 1024 * 1024) req.destroy(new Error('响应过大')); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 10000, () => req.destroy(new Error('请求超时')));
  });
}

// Minimal, dependency-free XML/HTML entity decode + tag strip.
function decodeXml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#0183;/g, '·').replace(/&ensp;/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/阅读更多|Read more|(^|\s)摘录(\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decodeXml(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    const url = tag(b, 'link');
    const snippet = tag(b, 'description');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    items.push({ title, url, snippet });
    if (items.length >= 10) break;
  }
  return items;
}

// Parse Bing's HTML result page. Richer than RSS: snippets are longer and
// usually carry a date, which matters a lot for "latest ..." questions.
function parseBingHtml(html) {
  const items = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  for (const b of blocks) {
    const hm = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!hm) continue;
    const url = decodeXml(hm[1]);
    const title = decodeXml(hm[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    let snippet = '';
    const pm = b.match(/<p[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (pm) snippet = decodeXml(pm[1]);
    items.push({ title, url, snippet });
    if (items.length >= 10) break;
  }
  return items;
}

// DuckDuckGo HTML fallback. Its links are wrapped in a uddg= redirect, so
// unwrap them before handing URLs to the model or opening them.
function parseDdgHtml(html) {
  const items = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || '')) && items.length < 10) {
    let url = decodeXml(m[1]);
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) {
      try { url = decodeURIComponent(wrapped[1]); } catch (_) { /* keep wrapped url */ }
    }
    const title = decodeXml(m[2]);
    const snippet = decodeXml(m[3]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    items.push({ title, url, snippet });
  }
  return items;
}

// Brand / company names cause Bing's Chinese endpoint to show an "entity
// panel" (official site + stock quote + encyclopedia) instead of real articles.
// Strip them from "latest X" questions so the search is about the CATEGORY.
const BRAND_RE = /(英伟达|nvidia|geforce|amd|英特尔|intel|苹果|apple|华为|huawei|小米|xiaomi|三星|samsung|微软|microsoft|谷歌|google|百度|阿里|腾讯|特斯拉|tesla|比亚迪|联想|lenovo|戴尔|dell|惠普|hp)/gi;
// Generic nouns that are not real search categories — if stripping leaves only
// one of these, keep the original wording instead of searching "版本 天梯图".
const WEAK_CATEGORY = /^(版本|型号|价格|怎么样|是什么| news |信息|情况|问题|区别)$/i;

// Turn a conversational question into keyword queries that actually retrieve
// substantive pages. "英伟达最新显卡是什么" -> "显卡 天梯图 2026", which hits
// real ranking articles instead of NVIDIA's home page + stock quote.
function rewriteQuery(q) {
  const original = String(q || '').trim();
  let s = original
    .replace(/^(请问|帮我|告诉(我|一下)?|我想知道|麻烦你?|那个)/, '')
    .replace(/(是什么|什么意思|是怎么样的|怎么样|如何|多少钱|多少|什么时候|有哪些|吗|呢|[?？。])$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) s = original;
  const variants = [];

  // Split "英伟达 最新 显卡" into brand / intent / category.
  const m = s.match(/^([\u4e00-\u9fa5A-Za-z ]{1,12}?)\s*(最新|最好|推荐|排行|排名|性价比|哪个|哪款|newest|latest|best)\s*([\u4e00-\u9fa5A-Za-z0-9 ]{1,20})$/i);
  let category = m ? m[3].trim() : s.replace(BRAND_RE, '').trim();
  // "Python 最新版本" => category "版本" is too generic; fall back to full query.
  if (WEAK_CATEGORY.test(category)) {
    category = m ? (m[1].trim() + m[3].trim()) : s;
  }
  if (category && category.length >= 2) {
    // The category-only "天梯图" query is the one that finds real content.
    variants.push(category + ' 天梯图 ' + CURRENT_YEAR);
    variants.push(category + ' 排行 评测 ' + CURRENT_YEAR);
    // Keep a brand-less "series" query for product-generation questions.
    variants.push(category + ' 系列 型号 参数 ' + CURRENT_YEAR);
  }
  // Also try the original words + year (but with brand stripped).
  const stripped = s.replace(BRAND_RE, '').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== s && !/\b20\d{2}\b/.test(stripped)) {
    variants.push(stripped + ' ' + CURRENT_YEAR);
  }

  const out = [original];
  for (const v of variants) if (v && !out.includes(v)) out.push(v);
  return out.slice(0, 4);
}

// Rank results so that substantive pages come before brand home pages / wikis.
function scoreResult(r) {
  let sc = 0;
  let path = '';
  try { path = new URL(r.url).pathname; } catch (e) { /* ignore */ }
  if (!path || path === '/') sc -= 3;                       // pure home page
  if (/baike\.baidu|wikipedia|wiki\./i.test(r.url)) sc -= 2; // encyclopedia stub
  const snip = r.snippet || '';
  const text = snip + ' ' + r.title;
  // Off-topic results are the main reason answers look "stupid": stock quotes,
  // driver download pages and board bios are NOT product-model information.
  if (/(股价|股票|财报|行情|走势|东方财富|雪球|董事会|驱动程序|驱动下载| geforce 驱动)/i.test(text)) sc -= 4;
  if (snip.length > 60) sc += 2;                            // real content
  if (/\d{4}|\d{3,}/.test(snip)) sc += 1;                   // dates / model numbers
  if (/(评测|排行|天梯|发布|报价|参数|对比|型号|系列|202\d)/i.test(text)) sc += 2;
  return sc;
}

// Search Bing. Returns { ok, results, source, error }.
async function searchWeb(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, results: [], error: '搜索词为空' };
  const timeout = opts.timeout || 10000;
  const maxResults = opts.maxResults || 8;
  const queries = rewriteQuery(q);
  const all = [];
  const seen = new Set();
  let lastErr = '', usedSource = '';

  // Run EVERY query variant (original + rewrites) and merge their results.
  // Do not stop just because the first query returned brand home pages — the
  // rewritten keyword query is usually the one that finds real articles.
  for (const queryText of queries) {
    for (const src of SOURCES) {
      let results = [];
      try {
        const isDdg = src.kind === 'ddg';
        const searchPath = isDdg ? '/html/?q=' : '/search?q=';
        const suffix = isDdg ? '' : '&setlang=zh-hans';
        const html = await httpGet(
          'https://' + src.host + searchPath + encodeURIComponent(queryText) + suffix,
          isDdg ? Math.min(timeout, 6000) : timeout
        );
        results = isDdg ? parseDdgHtml(html) : parseBingHtml(html);
        usedSource = src.host + (isDdg ? '/html' : '/web');
        if (!results.length && !isDdg) {
          // Bing layout changed or was blocked — RSS is the next best thing.
          const xml = await httpGet('https://' + src.host + '/search?q=' + encodeURIComponent(queryText) + '&format=rss', timeout);
          results = parseRss(xml);
          usedSource = src.host + '/rss';
        }
      } catch (e) {
        lastErr = e.message || String(e);
        continue;
      }
      for (const r of results) {
        const key = r.url.replace(/[?#].*$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(r);
      }
      if (results.length) break; // this source worked; no need for the fallback host
    }
    // Keep going through every rewritten query — the keyword variant is often
    // the one that retrieves real articles. Total 2-3 requests, still fast.
  }

  if (!all.length) return { ok: false, results: [], error: lastErr || '搜索失败' };
  all.sort((a, b) => scoreResult(b) - scoreResult(a));
  // Drop brand home pages, stock quotes and encyclopedia stubs entirely —
  // feeding them to the model is what produced nonsense "40 series" answers.
  const good = all.filter((r) => scoreResult(r) > 0);
  const picked = (good.length >= 2 ? good : all).slice(0, maxResults);
  return { ok: true, results: picked, source: usedSource, query: q };
}

// Build the system message that injects search results into the chat context.
// Hard rule: for time-sensitive questions the model must NOT fall back to its
// stale training data — that is exactly what produced "RTX 40 series" answers.
function buildContextMessage(results, query) {
  if (!results || !results.length) return '';
  const lines = results.map((r, i) => {
    const snip = r.snippet ? ' — ' + r.snippet : '';
    return '[' + (i + 1) + '] ' + r.title + '\n    URL: ' + r.url + '\n    摘要:' + snip;
  });
  return '【联网搜索结果 · 用户问题：' + query + '】\n'
    + '以下是刚刚实时检索到的网页资料。回答时必须严格遵守：\n'
    + '1. 只能依据下面的资料回答。凡涉及最新产品、型号、版本、价格、年份等时效性内容，绝对禁止使用你训练数据里的旧知识（你的知识早已过时）。\n'
    + '2. 引用资料时标注来源编号，例如 RTX 50 系列 [1]。\n'
    + '3. 如果资料没有给出明确答案，必须如实回答「搜索结果中没有找到明确答案」，并提示用户查看来源链接。严禁用常识推测或用旧知识补全。\n'
    + '4. 不要编造资料中不存在的型号、参数、数字或来源编号。\n\n'
    + lines.join('\n');
}

module.exports = { searchWeb, buildContextMessage, setProxy, parseRss, parseBingHtml, parseDdgHtml, rewriteQuery };
