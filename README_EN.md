# Guncat Work (Android)

[中文](README.md) | [English](README_EN.md)

> Guncat Work's agent harness, ported to Android: **three conversation modes, three streaming
> provider protocols, a multi-round tool loop with a sandboxed workspace, interactive UI,
> Office output, and an auditable command path** — shipped as an APK.

![Android](https://img.shields.io/badge/Android-9%2B-3ddc84)
![minSdk](https://img.shields.io/badge/minSdk-28-blue)
![targetSdk](https://img.shields.io/badge/targetSdk-28-blue)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![version](https://img.shields.io/badge/version-0.2.1-blue)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

| Chat | Session drawer | Workspace |
| --- | --- | --- |
| ![Chat](docs/images/android-home.png) | ![Sessions](docs/images/android-sessions.png) | ![Workspace](docs/images/android-workspace.png) |

Settings and the workspace are full-screen pages on phones, not scaled-down desktop dialogs:

![Settings](docs/images/android-settings.png)

## Three modes

| Mode | Reference | On Android |
| --- | --- | --- |
| ✦ **Interactive** | GPT **Intelligent UI** | One prompt produces an operable UI; control values recompute immediately |
| 🛠 **Work** | **DeepSeek Harness** (Codex-style agent loop) | Multi-round tool loop + per-conversation sandbox + built-in tools |
| Chat | — | Plain conversation, no workspace |

All three share the same business core (`src/core/`) with the desktop build.

## What the Android port does

This is not a WebView wrapper around the Electron UI. Android has no Node main process, no
`/bin/sh`, and no writable install directory, so those layers were replaced:

| Desktop capability | Android implementation |
| --- | --- |
| Electron main process + preload IPC | **In-WebView host**: `SessionManager` runs inside the page; `window.guncat` keeps the exact preload signature, so the React UI is unchanged |
| Node `fs` | **memfs + IndexedDB persistence**: synchronous `fs` semantics retained; conversations, settings and workspace files survive restarts |
| Node `child_process` | **Bundled Termux userland**: bash, coreutils, grep/sed/awk, tar, curl, **Python, pip and Git** ship inside the APK and are extracted to app-private storage on first launch — no external Termux. System `/system/bin/sh` is the fallback |
| Node `vm` for `run_js` | **Web Worker**: a timeout or infinite loop is really terminated |
| Electron dialogs | HTML file input (`onShowFileChooser`) + native download/share bridge |
| Electron `nativeImage` | `createImageBitmap` + canvas (resize, thumbnails, SVG rasterization) |
| Electron `shell.openPath` | MediaStore download, then system `ACTION_VIEW` / `ACTION_SEND` |
| Direct model API `fetch` | **Local same-origin reverse proxy on 127.0.0.1**: avoids WebView CORS and flushes SSE chunks as they arrive |
| Web Speech TTS | Android native `TextToSpeech`; voice input stays MediaRecorder + provider transcription |
| Desktop three-column layout | **Phone layout**: full-screen chat, left session drawer, composer chips, full-screen workspace/settings, safe areas, 44px touch targets |

### Mobile UI notes

- The top bar keeps only "drawer / title / workspace"; model, reasoning effort, thinking and web
  search become chips above the composer instead of a crowded top bar or an extra bottom sheet.
- The composer stays on one row: voice + camera on the left, input in the middle, upload + round send
  on the right. Upload and camera automatically target chat attachments or the workspace by mode.
- The sidebar is narrower (300px) and its bottom workspace entry is gone (the top-bar folder opens it
  directly); table extraction moved to the sidebar footer.
- The sidebar is a slide-over drawer that closes after selecting a conversation, engine or mode.
- The composer uses 16px text and a 46px minimum height; `adjustResize` keeps it above the keyboard.
- Markdown tables scroll horizontally; icon buttons are at least 40×40.
- Android back first closes drawers/dialogs/workspace, then requires a double press to exit.

## Install

1. Install `release/Guncat-Work-0.2.1-android.apk` (Android 10+; allow unknown sources).
2. Open **Settings → Provider**, fill Base URL, API Key and model, then save.
   Supported: OpenAI Completions, OpenAI Responses, Anthropic Messages (all with image input).
3. Use the chat. In work/interactive modes, files enter through **Workspace → Upload**; in chat
   mode use the paperclip.

## Build the APK

Requirements:

- Node.js 20+
- JDK 17+ (validated with 21/25)
- Android SDK `platforms/android-35` and `build-tools/35.0.0` (no Gradle required)
- SDK lookup: `ANDROID_HOME` → `ANDROID_SDK_ROOT` → `.android-sdk/` → `%LOCALAPPDATA%\Android\Sdk`

```bash
npm install
npm run dist:android
```

Output: `release/Guncat-Work-<version>-android.apk`

The script runs: Vite mobile build → copy `resources/` → `aapt2 compile/link` → `javac` →
`d8` → `zipalign` → `apksigner`. The first build creates a local signing key under
`android/keystore/`; keep it for future upgrades.

Front-end-only development:

```bash
npm run dev:android   # http://127.0.0.1:5174
```

Without `window.GuncatAndroid`, saving, system TTS and the streaming proxy degrade to browser
behavior. The APK is the source of truth for full capability.

## Built-in Linux terminal

`run_command` executes **real processes**, with no separate Termux install:

- **Built-in terminal (default)**: an arm64 Termux userland ships inside the APK — `bash`,
  coreutils, `grep` `sed` `awk` `find` `xargs` `tar` `curl`, `apt`, plus a real toolchain:
  **Node 26 + npm 11, ffmpeg, jq, sqlite3, ssh/scp, rsync, make, rg, fd, dig/nslookup,
  htop, wget, zip**, **Python 3.14 + pip + numpy/scipy/pillow/lxml**, and **Git**.
  On first launch the ~205MB bootstrap is extracted into app-private storage; afterwards commands
  run directly. Real pipes, redirections, globbing, command substitution, loops/functions,
  `&&`/`||`, exit codes and background jobs all work.
- Not bundled: `pandoc`, ImageMagick, `gcc/clang`, pandas, matplotlib — each is a 30–80MB deb
  (100–200MB installed) and the Termux repo has no arm64 pandas/matplotlib builds. Pure-Python
  packages can be added with the bundled `pip`.
- Before each command the session workspace is mirrored from memfs to app-private storage
  (`.../files/guncat-data/files/workspaces/<conversation>`), and new/modified/deleted files are synced
  back afterwards — so `ls`, `grep -r`, `tar` and `git status` see the same files as the UI.
- **System shell (fallback)**: if the built-in terminal is unavailable (non-arm64 or extraction
  failure), the app can use `/system/bin/sh` (mksh + toybox) without the tools above.
- Settings → “Terminal (Shell)” switches backends, shows extraction progress and can reinstall.

The APK grows to ~211MB and `targetSdk` is pinned to **28**: Android 10+ forbids apps targeting
29+ from executing files in app-private storage (Termux itself has always used 28). This is a hard
requirement for the built-in terminal.

Mirror limits: 8 MB per file and 32 MB per sync; settings, conversation history and API keys are
never mirrored. Oversized files are reported explicitly instead of silently skipped.

## Capability matrix

| Capability | Android |
| --- | --- |
| Streaming chat, reasoning, web search | ✅ |
| Work-mode agent loop, 45 tools, skills | ✅ (command tools use the built-in Linux terminal) |
| Interactive UI rendering | ✅ |
| Office generation (docx/xlsx/pptx/svg) | ✅ saved to `Downloads/Guncat Work` |
| Image viewing / thumbnails / SVG rasterization | ✅ |
| Chat attachments + workspace upload | ✅ system file picker |
| Table extraction (vision model) | ✅ |
| Read-aloud | ✅ system TTS |
| Voice input | ✅ MediaRecorder + provider transcription |
| Persistence | ✅ IndexedDB (app-private, removed on uninstall) |
| Built-in Linux terminal (bash / Python / pip / Git) | ✅ bundled in the APK, arm64; extracted on first launch |
| PDF parsing / search / page rendering | ✅ PDF.js (main-thread fake worker + canvas, no Web Worker); CJK CMaps, standard fonts and wasm bundled |
| Custom workspace directory | ⚠️ not supported; use the app sandbox and ZIP export |
| "Reveal in file manager" | ⚠️ replaced by save/share to Downloads |
| Long background tasks | ⚠️ WebView may be frozen in background; keep the app in foreground |

## Layout

```text
src/core/        shared business core (no platform code)
src/main/        Electron main process (desktop)
src/renderer/    React UI (shared)
src/mobile/      Android host: boot, window.guncat host, browser kits, shims, shell, native bridge
android/         Java WebView shell, local server/proxy, bundled Termux bootstrap, keystore
```

## Verification

Browser smoke tests (Edge/Chrome at 390×844) cover: first paint, drawer, quick-settings sheet,
full-screen settings; save config → create conversation → mocked SSE streaming → reload persistence;
work mode tool call (`run_command` → built-in terminal → result → final answer); shell pipes and
redirections; the JS fallback used by the browser preview and its 127 hint for missing commands;
`run_js` input/output and worker timeout; plus `npm run typecheck` across node/web/mobile.

## Privacy

- Data lives in app-private IndexedDB; only explicit exports reach Downloads.
- API keys are stored in app-private config in plaintext (no desktop-style OS credential vault);
  the settings UI says so.
- Model requests are forwarded through a loopback-only proxy guarded by a per-launch random token.

## Known limitations

1. The built-in terminal is **arm64-only**; other ABIs fall back to the system shell. `targetSdk`
   is pinned to 28 (apps targeting 29+ cannot execute app-private files), which is why the app is
   sideload-only.
2. First launch extracts ~560MB; the APK is ~211MB.
3. `pkg install` packages still contain Termux's original paths and are not rewritten yet; the
   bundled Python/pip/Git work out of the box.
4. Background execution is not guaranteed (no foreground service).
5. No custom workspace directory and no system "open with" intake.
6. PDF is read-only: parsing, search and page rendering are available; creation, editing, merging,
   watermarking, form filling and OCR text layers are not.

## Docs

- [Android porting notes](docs/ANDROID.md)
- [Desktop ↔ HarmonyOS porting archive](docs/PORTING.md)
- [Changelog](CHANGELOG.md)

## License

GPL-3.0. The built-in terminal uses the Termux bootstrap (GPL-3.0); see
[docs/THIRD-PARTY.md](docs/THIRD-PARTY.md).
