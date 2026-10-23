# 项目约定

本文件记录人类维护者对 Agent 的长期约定，每轮随运行时快照注入，按此工作。

## 构建与打包（Android 为主）

- **每次任务完成后，必须重新打包 APK**：执行 `npm run dist:android`。
  - 该脚本（`scripts/build-android.mjs`）会先跑 `vite build --config vite.mobile.config.ts` 重新构建 `src/mobile` 的前端产物到 `android/app/src/main/assets/public`，再复制 `resources/`，随后用 SDK 自带工具链（aapt2 → javac → d8 → zipalign → apksigner）出包。
  - 产物：`release/Guncat-Work-<version>-android.apk`。**不要**只跑 Vite 或只改 assets 就宣称完成。
  - 需要 JDK 17+ 与 Android SDK（platform 35 + build-tools 35.0.0）；SDK 放在项目内 `.android-sdk/` 或设置 `ANDROID_HOME`。
- 桌面版（Electron）仍保留原打包链路：`npm run dist:setup` 产出 `release/Guncat-Work-<version>-setup.exe`。Android 任务不要求跑它，除非改动同时影响桌面端。
- 打包完成后向用户报告产物路径、版本号与体积；打包失败时如实报告失败步骤与原始输出，不要谎报成功。

## 代码与提交

- 使用 git 管理项目。完成任务后提交，提交信息用 `type(scope): 中文摘要` 的形式（如 `fix(command): ...`）。
- 面向用户阅读的交付物用 .docx/.xlsx/.pptx；代码与配置保持源格式。
- `.smoke/`、`.tmp/`、`out/`、`android/keystore/*.jks`、`.android-sdk/` 等属本地产物，已在 gitignore 内，不要提交。

## 平台边界

- `src/core/` 是与桌面/鸿蒙共享的业务内核，**禁止**在这里写 WebView/Android 专属代码；平台差异放在 `src/mobile/`（浏览器适配层、宿主、原生桥）。
- `run_command` 在 Android 上是**真实进程**：随包内置 Termux 用户态（`android/.../TermuxBootstrap.java` 首次解压，`ShellManager.java` 跑 `abcd/bin/bash`），JS 侧在 `src/mobile/platform/shellExec.ts` 与 `mirror.ts`；系统 `/system/bin/sh` 是兜底。
  `targetSdk` 必须是 28（Android 10+ 禁止 targetSdk ≥ 29 执行应用私有目录文件），内置 bootstrap 的路径按等长规则改写（见 `scripts/prepare-termux-bootstrap.py`）。`src/mobile/platform/shell.ts` 只是浏览器预览的回退实现，**不要**把它当成真机能力描述。改执行层、bootstrap 或镜像边界时同步更新 README、`docs/ANDROID.md`、`docs/THIRD-PARTY.md` 与 `android-check.mjs` 的断言。
- 桌面构建与 Android 构建共用渲染层组件；新增界面必须同时检查 `mobile.css` 的窄屏表现。

## 危险命令审批（CommandGuard）

- 判定层在 `src/core/service/CommandGuard.ts`，审批链路在 `src/core/service/CommandService.ts`。
- 改动判定规则后，必须同步在 `scripts/ipc-check.mjs` 补回归用例（判定层 + 集成层各一组），并确保「正常命令不被误伤」。
- 交付前跑 `npm run typecheck` 与 `node --check scripts/ipc-check.mjs`。
