# 第三方组件与许可

本项目以 **GPL-3.0** 发布（见根目录 `LICENSE`）。Android 版内置了一套 Termux 用户态，
它来自 Termux 社区的开源项目，同样以 GPL-3.0 发布。

## Termux bootstrap

- 项目：<https://github.com/termux/termux-app>
- 包构建：<https://github.com/termux/termux-packages>
- 使用的 release：`bootstrap-2026.10.18-r1+apt.android-7`
- 文件：`bootstrap-aarch64.zip`（arm64）
  <https://github.com/termux/termux-packages/releases/tag/bootstrap-2026.10.18-r1%2Bapt.android-7>
- 许可：GPL-3.0（各子包另带自己的许可证，解压后位于 `share/LICENSES/` 与各包的
  `share/doc/<包>/` 下）

我们在构建期做了两件事，没有修改上游源码仓库：

1. 把二进制/脚本里写死的 `/data/data/com.termux/files/usr` 与
   `/data/data/com.termux/files/home` 按**等长**规则替换为本应用的私有目录前缀
   （`/data/data/com.guncat.work/abcd`、`.../abcde`），见
   `scripts/prepare-termux-bootstrap.py`；
2. 从 Termux 镜像下载 `python`、`git` 及其依赖的 `.deb`，把 `data.tar.xz` 合并进
   bootstrap，并做同样的路径替换，见 `scripts/add-termux-packages.py`。

对应的上游源码可从上面的 GitHub 仓库与 termux-packages 的构建脚本获取；本项目也提供
上述生成脚本，便于复现同一份二进制。若需要某个子包的完整源码归档，请按包名在
termux-packages 仓库中找到对应 `packages/<包名>/build.sh` 及其源码地址。

## PDF.js

- 项目：<https://github.com/mozilla/pdf.js>
- 包：`pdfjs-dist@5.7.284`（`legacy/build/pdf.mjs` 与 `pdf.worker.min.mjs`）
- 许可：Apache-2.0（见 `node_modules/pdfjs-dist/LICENSE`，打包产物中的
  `assets/public/pdfjs/*` 保留上游 LICENSE 文件）
- 用途：Android 端的 PDF 文字层解析、关键词搜索与页面转图（`parse_document` /
  `search_pdf` / `pdf_to_images`）
- 随包数据：`cmaps/`、`standard_fonts/`、`wasm/`、`iccs/` 由 `vite.mobile.config.ts`
  在构建时从 `node_modules/pdfjs-dist` 原样复制，未做修改

## 说明

- Termux 是 Termux 社区的项目名称；本项目只是复用其公开的 bootstrap 与包构建产物，
  与 Termux 官方没有隶属关系。
- 内置终端只随 APK 分发，不单独售卖；APK 与源码同样受 GPL-3.0 约束。
