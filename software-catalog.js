// A small, curated catalogue of official installer URLs. No third-party
// mirror, no repackaged builds. If a versioned link ages out, the "官网" link
// still takes the user to the vendor's own download page.
const CATALOG = [
  {
    id: '7zip', name: '7-Zip', category: '压缩', desc: '开源压缩/解压，支持 7z 与 RAR 读取',
    url: 'https://www.7-zip.org/a/7z2409-x64.exe', fileName: '7z2409-x64.exe', site: 'https://www.7-zip.org/download.html',
  },
  {
    id: 'vscode', name: 'Visual Studio Code', category: '开发', desc: '微软官方用户版安装包',
    url: 'https://update.code.visualstudio.com/latest/win32-x64-user/stable', fileName: 'VSCodeUserSetup-x64.exe', site: 'https://code.visualstudio.com/Download',
  },
  {
    id: 'chrome', name: 'Google Chrome', category: '浏览器', desc: '谷歌官方独立安装包（64 位）',
    url: 'https://dl.google.com/chrome/install/ChromeStandaloneSetup64.exe', fileName: 'ChromeStandaloneSetup64.exe', site: 'https://www.google.com/chrome/',
  },
  {
    id: 'firefox', name: 'Firefox', category: '浏览器', desc: 'Mozilla 官方中文版',
    url: 'https://download.mozilla.org/?product=firefox-latest&os=win64&lang=zh-CN', fileName: 'Firefox-Setup.exe', site: 'https://www.mozilla.org/zh-CN/firefox/new/',
  },
  {
    id: 'vlc', name: 'VLC media player', category: '影音', desc: '开源播放器，几乎通吃所有格式',
    url: 'https://download.videolan.org/pub/videolan/vlc/3.0.21/win64/vlc-3.0.21-win64.exe', fileName: 'vlc-3.0.21-win64.exe', site: 'https://www.videolan.org/vlc/download-windows.html',
  },
  {
    id: 'notepadpp', name: 'Notepad++', category: '开发', desc: '轻量代码/文本编辑器',
    url: 'https://github.com/notepad-plus-plus/notepad-plus-plus/releases/latest/download/npp.Installer.exe', fileName: 'npp.Installer.exe', site: 'https://notepad-plus-plus.org/downloads/',
  },
  {
    id: 'git', name: 'Git for Windows', category: '开发', desc: '官方 GitHub Release 安装包',
    url: 'https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe', fileName: 'Git-64-bit.exe', site: 'https://gitforwindows.org/',
  },
  {
    id: 'python', name: 'Python 3.12', category: '开发', desc: 'Python 官方 Windows 安装包',
    url: 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe', fileName: 'python-3.12.7-amd64.exe', site: 'https://www.python.org/downloads/windows/',
  },
  {
    id: 'ollama', name: 'Ollama', category: 'AI', desc: '本地大模型运行时官方安装包',
    url: 'https://ollama.com/download/OllamaSetup.exe', fileName: 'OllamaSetup.exe', site: 'https://ollama.com/download',
  },
  {
    id: 'etcher', name: 'balenaEtcher', category: '工具', desc: '制作系统启动盘的开源工具',
    url: 'https://github.com/balena-io/etcher/releases/latest/download/balenaEtcher-Setup-x64.exe', fileName: 'balenaEtcher-Setup-x64.exe', site: 'https://www.balena.io/etcher',
  },
  {
    id: 'audacity', name: 'Audacity', category: '影音', desc: '开源音频编辑软件',
    url: 'https://github.com/audacity/audacity/releases/latest/download/Audacity-win-64bit.exe', fileName: 'Audacity-win-64bit.exe', site: 'https://www.audacityteam.org/download/',
  },
  {
    id: 'mailmaster', name: '网易邮箱大师', category: '办公', desc: '网易官方邮箱客户端',
    url: 'https://res.126.net/dl/client/pcmail/dashi/mail5.exe', fileName: 'mail5.exe', site: 'https://mail.163.com/dashi/',
  },
];

function listSoftware(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return CATALOG.slice();
  return CATALOG.filter((s) =>
    [s.name, s.category, s.desc, s.id].some((v) => String(v).toLowerCase().includes(q))
  );
}

function findSoftware(id) {
  return CATALOG.find((s) => s.id === id || s.name.toLowerCase() === String(id || '').toLowerCase()) || null;
}

module.exports = { CATALOG, listSoftware, findSoftware };
