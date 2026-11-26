# ModelVault

**A local AI model manager: download anything, manage everything, know if your GPU can run it.**

Full Chinese UI. Free and open source. No telemetry, no account, no cloud.

[Download the latest installer (Windows x64)](../../releases/latest) · [中文文档](#中文说明)

## Features

- **Universal model download** — Search the entire Hugging Face catalog (GGUF / SafeTensors / ONNX / any format), or paste **any direct URL** from any site. Small, niche, uncensored, mainstream — if there's a link, you can download it.
- **All-brand GPU detection + VRAM fit** — Detects every GPU in your system (NVIDIA / AMD / Intel + Chinese brands: Moore Threads, Biren, MetaX, Hygon, JMG, Enflame...), shows each one's VRAM, and labels every model:
  - 🟢 显存充足 (fits comfortably)
  - 🟡 显存稍不足 (tight / needs partial offload)
  - 🔴 显存完全不足 (won't fit)
- **Local model management** — Recursive GGUF scan with real metadata parsing (quantization, architecture, context length, parameter count), tags & notes, sorting/filtering, llama.cpp / Ollama command generation, CSV export.
- **SHA256 checksum** — One-click hash calculation for any local model file.
- **Robust downloads** — Progress, pause/resume, cancel, retry, disk-space check, `.part` temp files (no corrupt files), corrupt-file auto redetection.
- **Local crash logs** — Written to `%APPDATA%\model-vault\logs\`, rotated, **never uploaded**.

## Download & install

Grab `ModelVault-Setup-2.2.1.exe` from [Releases](../../releases/latest). Run it, pick a language, accept the license, choose an install path.

> **Note on security warnings**: This project is published by an individual developer **without a commercial code-signing certificate**, so Windows SmartScreen / your browser / antivirus may show a warning. This is expected. See [Safe handling of download warnings](#download-warning) below — a few clicks and you're in. You can (and should) verify the SHA256 yourself before installing.

## Verify the download

```powershell
Get-FileHash "C:\path\to\ModelVault-Setup-2.2.1.exe" -Algorithm SHA256
```

Expected: `b9d431555d8fa7236bcd835ae729c79468cb2ca3876b73610338683c42860b84`
Expected size: 76,135,387 bytes

## Build from source

Requires Node.js 18+ and npm.

```bash
npm install
npm start          # run from source
npm run dist       # build the Windows NSIS installer into dist/
```

Uses Electron 28.3.3 and electron-builder 24.13.3. No runtime npm dependencies beyond Electron itself.

## Privacy

Everything runs locally. The only network calls are: model search/download from Hugging Face (or a direct URL you paste) and GPU detection (local system APIs). No telemetry, no analytics, no data upload.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled open-source components and their licenses.

---

## 中文说明

**ModelVault — 本地模型管理器**：下载不设限、全品牌显卡显存判断、模型管理与校验，全中文界面，免费开源。

- **下载不设限**：搜索 Hugging Face 全量模型（任意格式），或粘贴任意直链，小众冷门通吃
- **显存判断**：自动识别所有品牌显卡（含国产卡），按模型体积标注"显存充足 / 稍不足 / 完全不足"
- **管理**：GGUF 元数据解析、标签备注、 llama.cpp / Ollama 命令、CSV 导出、SHA256 校验
- **隐私**：除下载和显卡检测外完全离线，不上传任何数据

安装：从 [Releases](../../releases/latest) 下载 `ModelVault-Setup-2.2.1.exe`，双击安装。软件内 `帮助 → 使用指南`（F1）有完整教程。

<a name="download-warning"></a>
### 下载后遇到安全警告怎么办

未签名软件的常见现象，不是病毒：

1. **浏览器提示"此文件可能有害"** → 点「更多信息」→「仍要保留」
2. **SmartScreen 提示"Windows 已保护你的电脑"** → 点「更多信息」→「仍要运行」
3. **杀软报毒/隔离** → 选「允许/信任/加白名单」；已隔离的去隔离区恢复并加信任
4. **自己核对**：用上面的 `Get-FileHash` 命令比对 SHA256，一致即未被篡改
