# ModelLodge 第三方开源组件致谢 / Third-Party Notices

ModelLodge 的诞生站在众多开源项目的肩膀上。以下列出本软件使用、嵌入或依赖的开源组件及其许可证。
感谢所有开发者为开源社区做出的贡献。

---

## 一、运行时组件（随软件一起分发）

### 1. Electron 28.3.3
- **许可证**：MIT License
- **版权**：Copyright (c) 2013-2024 GitHub, Inc.
- **项目**：https://www.electronjs.org/
- **源代码**：https://github.com/electron/electron
- **用途**：跨平台桌面应用框架，本软件的运行基础。
- **完整许可证**：见安装目录 `LICENSE.electron.txt`

### 2. Chromium（由 Electron 内嵌）
- **许可证**：BSD-style License（含多个子组件的许可，如 BSD-3-Clause、MIT、Apache-2.0、LGPL 等）
- **版权**：Copyright (c) 2012 The Chromium Authors. All rights reserved.
- **项目**：https://www.chromium.org/
- **完整许可证**：见安装目录 `LICENSES.chromium.html`

### 3. Node.js（由 Electron 内嵌）
- **许可证**：MIT License
- **版权**：Copyright (c) Node.js contributors
- **项目**：https://nodejs.org/
- **用途**：文件系统读写、网络通信、子进程调用、HTTPS 下载。

### 4. V8 JavaScript Engine（由 Chromium 内嵌）
- **许可证**：BSD-3-Clause
- **版权**：Copyright 2016, the V8 project authors.
- **项目**：https://v8.dev/

### 5. Skia Graphics Library（由 Chromium 内嵌）
- **许可证**：BSD-3-Clause
- **版权**：Copyright (c) 2006 Google Inc.
- **项目**：https://skia.org/

### 6. zlib（由 Node.js 内嵌）
- **许可证**：zlib License
- **项目**：https://zlib.net/

### 7. OpenSSL（由 Node.js 内嵌）
- **许可证**：Apache License 2.0（含 OpenSSL 例外条款）
- **项目**：https://www.openssl.org/
- **用途**：HTTPS 加密通信（模型搜索与下载）。

---

## 二、构建工具（仅开发阶段使用，不随软件分发）

### 8. electron-builder 24.13.3
- **许可证**：GPL-3.0
- **版权**：Copyright (c) 2016 Stefan Kerkhoff
- **项目**：https://www.electron.build/
- **源代码**：https://github.com/electron-userland/electron-builder
- **用途**：将源代码打包为 Windows NSIS 安装程序。

### 9. npm / Node Package Manager
- **许可证**：Artistic License 2.0
- **项目**：https://www.npmjs.com/

---

## 三、数据与模型来源

本软件的模型搜索与下载功能访问以下公共服务：

### 10. Hugging Face / hf-mirror
- **服务**：Hugging Face Hub（https://huggingface.co）及其国内镜像 hf-mirror.com
- **说明**：本软件仅通过其公开 API 检索模型元数据、下载用户主动选择的模型文件。
- **注意**：各模型本身的许可证由其上传者决定，请在使用具体模型前查阅对应模型页面的许可证声明。本软件不对第三方模型内容承担任何权利担保。

---

## 四、许可证全文

### MIT License（适用于 Electron、Node.js）

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD 3-Clause License（适用于 V8、Skia）

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
  * Redistributions of source code must retain the above copyright notice,
    this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.
  * Neither the name of the copyright holder nor the names of its contributors
    may be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

> Chromium 及其子组件的完整许可证原文（篇幅很长）见安装目录下的
> `LICENSES.chromium.html` 文件，该文件由 electron-builder 自动随软件分发。

---

## 四·补、llama.cpp 推理引擎（随软件分发）

ModelLodge 内置了 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的运行时，
放在安装目录的 `resources\llama\` 下，用于在本机直接运行 GGUF 模型。
其中包含 CPU 后端与 Vulkan 后端（`ggml-vulkan.dll`）。

- 版本：llama.cpp b12811（build 12811, commit 00d5c142c），Windows x64 预编译包，来源为 ggml-org/llama.cpp 官方 GitHub Actions 构建产物（CPU + Vulkan）
- 许可证：MIT License
- 版权：Copyright (c) 2023-2024 The ggml authors
- 随包分发的二进制 SHA256（发布前核对）：
  - `llama-server.exe` — `a8ea7129882e77a29d014cfbb746092276b47fe2bdf04b7ffe5e6a5562d565e7`
  - `ggml-vulkan.dll` — `8c1fcd1843baac17868743df1e1fc77fd1f4b8a3002b25f68dd4f3e8030496c8`

**CUDA 后端说明（可选组件包）**：主安装包**不含** NVIDIA CUDA 二进制，体积保持在约 98 MB。需要 CUDA 加速的 NVIDIA 显卡用户可单独下载 `ModelLodge-CUDA12-Component.zip`（约 713 MB），在「设置 → CUDA 加速组件」里点「导入 CUDA 组件包」。导入后解压到 `%APPDATA%\modellodge\cuda\`，引擎会优先使用它；组件包存在时**独占** CUDA 运行时路径，不再扫描本机 LM Studio / llama.cpp 的 vendor 目录，避免两套 CUDA 12 DLL 混载。只有未安装组件包时，才会自动识别本机已有后端（CUDA 11 / 12 / 13 均支持）。CUDA 12 组件要求 NVIDIA 驱动 525 以上（CUDA 12.8 建议 570+），驱动过旧时软件自动回退 Vulkan / CPU。

组件包包含 `ggml-cuda.dll` 及 CUDA 运行时 DLL（`cudart64_12.dll`、`cublas64_12.dll`、`cublasLt64_12.dll`），来源为 llama.cpp 预编译后端与 NVIDIA CUDA Runtime。CUDA 运行时 DLL 由 NVIDIA Corporation 提供，受 [CUDA EULA](https://docs.nvidia.com/cuda/eula/) 约束；`ggml-cuda.dll` 及 llama.cpp 组件遵循 MIT License。组件包内文件的 SHA256：

- `ggml-cuda.dll` — `c5b6187b3afe4aa39efc0adfdc662c99211fae760ee3c29328cea15446cd4b1e`
- `cudart64_12.dll` — `c2c9a9c22a9bcba90e261825968836787b331038047a26770cffb7a583c28344`
- `cublas64_12.dll` — `9513540e4ec4c51ee9e7304138c2cc255c29a8c181f9e80c38efa25738becd99`
- `cublasLt64_12.dll` — `b199d1ff892a81b7fd3d57ba1781549609b41500b36008fef326038393ad46c7`
- 组件包整体 — `ca38e8228327798949eb71711fa9b739a14c4334d8ac7aa0e906165f597444b1`

```
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> llama.cpp 使用了 LLVM OpenMP Runtime，其许可证见同目录下的
> `LICENSE-LLVM-OpenMP`（Apache License 2.0 with LLVM Exceptions）。

---

## 五、结语

再次感谢 Electron、Chromium、Node.js 等开源项目团队，以及所有开源模型的创作者。
没有你们的工作，就没有 ModelLodge。

如果你发现本致谢清单有遗漏或错误，欢迎反馈更正。

— ModelLodge 团队，2026 年 11 月
