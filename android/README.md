# Android 工程

这是一个**不用 Gradle** 的最小 Android 工程：一个 `Activity` + 一个本地 HTTP 服务 +
一个真实命令执行桥。构建由根目录的 `scripts/build-android.mjs` 调 SDK 自带工具完成。

```text
app/src/main/
├── AndroidManifest.xml
├── assets/termux/            内置 Termux bootstrap（构建产物，勿手改）
├── java/com/guncat/work/
│   ├── MainActivity.java        WebView、文件选择、TTS、下载/分享、返回键
│   ├── BackgroundTaskService.java 任务期间前台保活（通知 + 唤醒锁 + Wi-Fi 锁）
│   ├── GuncatServer.java        静态资源 + /__fetch 流式反向代理
│   ├── TermuxBootstrap.java     首次解压内置用户态（zip + SYMLINKS.txt）
│   └── ShellManager.java        bash / 系统 sh 执行 + 工作区落盘
├── res/                    图标、主题（day/night）、网络安全配置
└── assets/public/          Vite 构建产物（由脚本生成，勿手改）
```

## 构建

```bash
# 在仓库根目录
npm run dist:android
```

SDK 查找：`ANDROID_HOME` → `ANDROID_SDK_ROOT` → `<repo>/.android-sdk` → `%LOCALAPPDATA%\Android\Sdk`。
需要 `platforms/android-35/android.jar` 与 `build-tools/35.0.0/{aapt2,d8,zipalign,apksigner}`。

## 版本与最低系统

- `minSdk 29`（Android 10）
- `targetSdk 35`
- 版本号取自根目录 `package.json`，由 `aapt2 link --version-code/--version-name` 覆盖清单值。

## 数据

应用私有 IndexedDB（WebView 的 origin 是 `http://127.0.0.1:47653`）。
**端口必须固定**：Chromium 的 IndexedDB 按 origin 隔离，端口一变就等于换了一个站点，
上次的数据会“消失”。`MainActivity.APP_PORT` 固定为 `47653`；只有端口被占用时
`GuncatServer` 才退回随机端口（此时那一轮启动读不到旧数据，日志里会记录）。
