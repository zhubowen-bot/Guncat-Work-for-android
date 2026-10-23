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
- 内置 Shell 是 Android 版对 `run_command` 的条件适配：只支持文件操作类 POSIX 子集（见 `src/mobile/platform/shell.ts`），不支持 Python/Node/git 等真实可执行文件。改命令集时同步更新 README 与 `docs/ANDROID.md`。
- 桌面构建与 Android 构建共用渲染层组件；新增界面必须同时检查 `mobile.css` 的窄屏表现。

## 危险命令审批（CommandGuard）

- 判定层在 `src/core/service/CommandGuard.ts`，审批链路在 `src/core/service/CommandService.ts`。
- 改动判定规则后，必须同步在 `scripts/ipc-check.mjs` 补回归用例（判定层 + 集成层各一组），并确保「正常命令不被误伤」。
- 交付前跑 `npm run typecheck` 与 `node --check scripts/ipc-check.mjs`。
