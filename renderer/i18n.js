// ModelLodge i18n dictionary — UI strings in zh / en / ja.
// Elements with data-i18n="key" get their textContent replaced on language change.
// Elements with data-i18n-ph="key" get their placeholder replaced.
const I18N = {
  zh: {
    // sidebar
    'nav.library': '模型库', 'nav.all': '全部模型', 'nav.recent': '最近添加', 'nav.download': '下载模型',
    'nav.arch': '架构', 'nav.folders': '文件夹', 'nav.addFolder': '添加文件夹',
    'gpu.title': '显卡', 'gpu.refresh': '刷新', 'gpu.detecting': '检测显卡中...', 'status.ready': '就绪',
    // toolbar
    'tool.searchPh': '搜索名称/路径/备注/标签...', 'tool.sort': '排序', 'tool.quant': '量化',
    'sort.name': '名称', 'sort.size': '大小', 'sort.modified': '添加时间', 'sort.context': '上下文长度',
    'quant.all': '全部',
    // stats
    'stat.models': '个模型', 'stat.size': '总大小', 'stat.folders': '个文件夹', 'stat.parseFail': '解析失败',
    'stat.gpus': '张显卡', 'stat.formats': '格式分布',
    // download view
    'dl.searchPh': '搜索任意模型，如 Qwen2.5、deepseek、llama...', 'dl.search': '搜索', 'dl.source': '源',
    'dl.type': '类型', 'dl.allTypes': '全部', 'dl.directUrl': '直链下载：',
    'dl.directPh': '粘贴任意下载链接（任何来源的模型文件都行）...', 'dl.download': '下载',
    'dl.featured': '精选推荐：', 'dl.tasks': '下载任务', 'dl.saveTo': '保存到：', 'dl.change': '更改',
    'dl.notSet': '未设置', 'dl.empty': '暂无下载任务',
    'dl.hintTitle': '搜索任意模型',
    'dl.hintBody': '搜索 Hugging Face 全量模型（GGUF / SafeTensors / ONNX 等任意格式），点进去选文件下载。',
    'dl.hintBody2': '小众模型、其它网站的模型？直接用上面的「直链下载」粘贴链接即可。',
    // settings
    'set.title': '设置', 'set.appearance': '外观', 'set.theme': '主题',
    'theme.light': '浅色', 'theme.dark': '深色', 'theme.system': '跟随系统',
    'set.showCols': '卡片显示信息', 'set.colArch': '架构', 'set.colQuant': '量化',
    'set.colCtx': '上下文', 'set.colParams': '参数量', 'set.saveCols': '保存显示设置',
    'set.network': '网络与下载', 'set.proxy': '代理地址（可选）', 'set.proxyHint': '支持 HTTP/HTTPS 代理，留空则直连。',
    'set.concurrent': '同时下载数', 'set.concurrentHint': '同时进行的下载任务数。网速快可调高。',
    'set.conflict': '同名文件冲突策略', 'set.testMirror': '测试两个源的速度',
    'set.saveNetwork': '保存网络设置', 'set.hfToken': 'Hugging Face Token',
    'set.scanDepth': '扫描深度', 'set.save': '保存', 'set.cancel': '取消',
    // about / footer
    'empty.noModels': '没有找到模型', 'empty.noModelsDesc': '添加一个包含模型文件的文件夹即可开始。',
    'empty.noMatch': '没有匹配的模型', 'empty.noMatchDesc': '换个关键词、架构或量化方式试试。',
    'dl.searching': '搜索中...', 'dl.searchFail': '搜索失败', 'dl.noResult': '没有找到模型', 'dl.noResultHint': '换个关键词试试。',
    'about.guide': '使用指南', 'about.licenses': '开源致谢', 'about.close': '关闭',
    'btn.export': '导出清单 CSV', 'btn.refresh': '刷新',
  },
  en: {
    'nav.library': 'Library', 'nav.all': 'All Models', 'nav.recent': 'Recently Added', 'nav.download': 'Download',
    'nav.arch': 'Architecture', 'nav.folders': 'Folders', 'nav.addFolder': 'Add Folder',
    'gpu.title': 'GPU', 'gpu.refresh': 'Refresh', 'gpu.detecting': 'Detecting GPUs...', 'status.ready': 'Ready',
    'tool.searchPh': 'Search name / path / notes / tags...', 'tool.sort': 'Sort', 'tool.quant': 'Quant',
    'sort.name': 'Name', 'sort.size': 'Size', 'sort.modified': 'Date Added', 'sort.context': 'Context Length',
    'quant.all': 'All',
    'stat.models': 'models', 'stat.size': 'Total Size', 'stat.folders': 'folders', 'stat.parseFail': 'Parse Errors',
    'stat.gpus': 'GPUs', 'stat.formats': 'Formats',
    'dl.searchPh': 'Search any model, e.g. Qwen2.5, deepseek, llama...', 'dl.search': 'Search', 'dl.source': 'Source',
    'dl.type': 'Type', 'dl.allTypes': 'All', 'dl.directUrl': 'Direct URL:',
    'dl.directPh': 'Paste any download URL (model files from anywhere)...', 'dl.download': 'Download',
    'dl.featured': 'Featured:', 'dl.tasks': 'Downloads', 'dl.saveTo': 'Save to:', 'dl.change': 'Change',
    'dl.notSet': 'Not set', 'dl.empty': 'No download tasks',
    'dl.hintTitle': 'Search any model',
    'dl.hintBody': 'Search all Hugging Face models (GGUF / SafeTensors / ONNX, any format), pick a file to download.',
    'dl.hintBody2': 'Rare model or from another site? Paste a direct URL above.',
    'set.title': 'Settings', 'set.appearance': 'Appearance', 'set.theme': 'Theme',
    'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
    'set.showCols': 'Card fields', 'set.colArch': 'Architecture', 'set.colQuant': 'Quant',
    'set.colCtx': 'Context', 'set.colParams': 'Parameters', 'set.saveCols': 'Save display settings',
    'set.network': 'Network & Download', 'set.proxy': 'Proxy (optional)', 'set.proxyHint': 'HTTP/HTTPS proxy, blank = direct.',
    'set.concurrent': 'Parallel downloads', 'set.concurrentHint': 'Number of simultaneous downloads.',
    'set.conflict': 'File conflict policy', 'set.testMirror': 'Test mirror speed',
    'set.saveNetwork': 'Save network settings', 'set.hfToken': 'Hugging Face Token',
    'set.scanDepth': 'Scan depth', 'set.save': 'Save', 'set.cancel': 'Cancel',
    'empty.noModels': 'No models found', 'empty.noModelsDesc': 'Add a folder with model files to get started.',
    'empty.noMatch': 'No matching models', 'empty.noMatchDesc': 'Try another keyword, architecture or quant.',
    'dl.searching': 'Searching...', 'dl.searchFail': 'Search failed', 'dl.noResult': 'No models found', 'dl.noResultHint': 'Try another keyword.',
    'about.guide': 'User Guide', 'about.licenses': 'Open Source Notices', 'about.close': 'Close',
    'btn.export': 'Export CSV', 'btn.refresh': 'Refresh',
  },
  ja: {
    'nav.library': 'モデルライブラリ', 'nav.all': 'すべて', 'nav.recent': '最近追加', 'nav.download': 'ダウンロード',
    'nav.arch': 'アーキテクチャ', 'nav.folders': 'フォルダー', 'nav.addFolder': 'フォルダーを追加',
    'gpu.title': 'GPU', 'gpu.refresh': '更新', 'gpu.detecting': 'GPU を検出中...', 'status.ready': '準備完了',
    'tool.searchPh': '名前/パス/メモ/タグを検索...', 'tool.sort': '並び替え', 'tool.quant': '量子化',
    'sort.name': '名前', 'sort.size': 'サイズ', 'sort.modified': '追加日', 'sort.context': 'コンテキスト長',
    'quant.all': 'すべて',
    'stat.models': 'モデル', 'stat.size': '合計サイズ', 'stat.folders': 'フォルダー', 'stat.parseFail': '解析エラー',
    'stat.gpus': 'GPU', 'stat.formats': '形式',
    'dl.searchPh': '任意のモデルを検索（例: Qwen2.5、deepseek）...', 'dl.search': '検索', 'dl.source': 'ソース',
    'dl.type': '種類', 'dl.allTypes': 'すべて', 'dl.directUrl': '直接 URL:',
    'dl.directPh': '任意のダウンロード URL を貼り付け...', 'dl.download': 'ダウンロード',
    'dl.featured': 'おすすめ:', 'dl.tasks': 'ダウンロード', 'dl.saveTo': '保存先:', 'dl.change': '変更',
    'dl.notSet': '未設定', 'dl.empty': 'タスクはありません',
    'dl.hintTitle': '任意のモデルを検索',
    'dl.hintBody': 'Hugging Face の全モデルを検索し、ファイルを選んでダウンロードできます。',
    'dl.hintBody2': 'マイナーなモデルは「直接 URL」にリンクを貼り付けてください。',
    'set.title': '設定', 'set.appearance': '外観', 'set.theme': 'テーマ',
    'theme.light': 'ライト', 'theme.dark': 'ダーク', 'theme.system': 'システムに従う',
    'set.showCols': 'カードの表示項目', 'set.colArch': 'アーキテクチャ', 'set.colQuant': '量子化',
    'set.colCtx': 'コンテキスト', 'set.colParams': 'パラメータ', 'set.saveCols': '表示設定を保存',
    'set.network': 'ネットワークとダウンロード', 'set.proxy': 'プロキシ（任意）', 'set.proxyHint': 'HTTP/HTTPS プロキシ。空欄で直接接続。',
    'set.concurrent': '並列ダウンロード数', 'set.concurrentHint': '同時に実行するダウンロード数。',
    'set.conflict': '同名ファイルの扱い', 'set.testMirror': 'ミラー速度をテスト',
    'set.saveNetwork': 'ネットワーク設定を保存', 'set.hfToken': 'Hugging Face Token',
    'set.scanDepth': 'スキャン深度', 'set.save': '保存', 'set.cancel': 'キャンセル',
    'empty.noModels': 'モデルが見つかりません', 'empty.noModelsDesc': 'モデルファイルを含むフォルダーを追加してください。',
    'empty.noMatch': '一致するモデルがありません', 'empty.noMatchDesc': 'キーワードやアーキテクチャを変えてお試しください。',
    'dl.searching': '検索中...', 'dl.searchFail': '検索失敗', 'dl.noResult': 'モデルが見つかりません', 'dl.noResultHint': '別のキーワードをお試しください。',
    'about.guide': '使い方', 'about.licenses': 'オープンソース',
    'about.close': '閉じる', 'btn.export': 'CSV をエクスポート', 'btn.refresh': '更新',
  },
};

let currentLang = 'zh';

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || (I18N.zh[key]) || key;
}

function applyLanguage(lang) {
  currentLang = I18N[lang] ? lang : 'zh';
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : currentLang === 'ja' ? 'ja' : 'en';
  // text nodes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.getAttribute('data-i18n'));
    if (v) el.textContent = v;
  });
  // placeholders
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const v = t(el.getAttribute('data-i18n-ph'));
    if (v) el.placeholder = v;
  });
  // option labels (value stays stable)
  document.querySelectorAll('[data-i18n-option]').forEach(el => {
    const v = t(el.getAttribute('data-i18n-option'));
    if (v) el.textContent = v;
  });
}
