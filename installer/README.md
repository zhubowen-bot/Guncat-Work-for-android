# 安装程序（Guncat Work Setup）

一条命令产出**单文件**安装包：

```bash
npm run dist:setup
# → release/Guncat-Work-<版本>-setup.exe
```

双击即可安装；装完出开始菜单项与桌面快捷方式，并在「设置 → 应用 → 已安装的应用」里登记，
自带卸载程序。

**这是「为所有用户安装」**：默认装到 `C:\Program Files\Guncat Work`，登记项与兼容层写 `HKLM`，
快捷方式放公共桌面 / 公共开始菜单。所以安装和卸载各需要**一次管理员授权**（清单是 `asInvoker`，
程序自己用 `runas` 重新拉起，所以 UAC 出现在窗口之前）。

> 为什么不是 `%LOCALAPPDATA%\Programs`：那是「当前用户安装」的位置（VS Code 用户版、Discord
> 都在那儿），好处是全程不弹 UAC，代价是只对当前用户可见。这里按需求选了机器级安装。
> 想切回去只需改 `DefaultDir()`，并把 `Reg.SetXxx(true, …)` 的 `true` 改回 `false`、
> 去掉 Startup 里的提权分支。

---

## 为什么不用 electron-builder 的 nsis 目标

仓库里那份 `electron-builder.yml` 是为「便携 + NSIS」写的，但这条路在本项目上走不通：

1. **界面。** electron-builder 的 NSIS 用的是标准 Win32 向导（下一页/上一步那一套），
   要改成圆角、渐变、自定义配色的现代界面，得换第三方皮肤插件（nsNiuniuSkin 之类），
   投入大、不可控，而且那类插件基本只在 32 位 ANSI 版 NSIS 上验证过。
2. **它在本机根本跑不到打包那一步。** 收集 node_modules 时 `app-builder-lib` 会用管道
   捕获子进程输出，而本机环境（受限令牌/沙箱）下 `spawn` 直接 `EPERM`。
   而本应用的运行时代码已被 vite 全部打进 `out/`，**没有任何依赖需要收集** —— 这一步本就是多余的。

于是安装程序改成用 **Windows 自带的 csc.exe 编译的 WPF 程序**：界面随便画，产物是单个 exe，
不需要任何第三方运行时。

## 它由哪几块拼成

```
release/Guncat-Work-<版本>-setup.exe
├── 安装程序界面 + 安装逻辑   installer/src/*.cs            （WPF，运行期 XamlReader 解析 XAML）
├── 应用本体                  payload.7z                    （与 npm run dist 的便携目录逐字节相同）
├── 解压器                    7za.exe                       （构建时从 electron-builder 缓存里取）
└── 卸载程序                  uninstall.exe                 （装完后释放到安装目录）
```

* **载荷**：`scripts/package-portable.mjs` 组装的便携目录，一字不改地压成 `payload.7z`（LZMA2）。
  这么做保证「装出来的」和「绿色版」永远是同一份文件，不会出现两份产物各自漂移。
* **7za.exe**：安装时用它解压。为什么不用 .NET 自带的 `ZipFile`：整包 380+ MB，
  deflate 与 LZMA2 的体积差在 60 MB 量级，解压速度也差好几倍。
  构建脚本按 `installer/vendor/7za.exe` → `%LOCALAPPDATA%\electron-builder\Cache\7zip@*\…\bin\7za.exe`
  的顺序查找。
* **卸载程序**：独立编译的小 exe，留在安装目录里。运行时会先把自己复制到 `%TEMP%` 再执行 ——
  它就在要删的那棵树里，Windows 不允许删除正在运行的映像（NSIS / Inno 用的也是这一套）。

## 安装时都做了什么

0. **提权**：不是管理员就用 `runas` 重新拉起自己（弹一次 UAC），后续步骤都在提权后的进程里做；
1. 校验目标目录与剩余空间；
2. 把内嵌的 `payload.7z` 与 `7za.exe` 释放到 `%TEMP%`，用 7za 解压到安装目录（带进度、速度、剩余时间）；
3. 释放 `uninstall.exe`；
4. 创建快捷方式 → **公共**桌面 / **公共**开始菜单
   （`C:\Users\Public\Desktop`、`C:\ProgramData\…\Start Menu\Programs`，含「卸载 Guncat Work」）；
   提权后进程可能跑在另一个账户下，所以不能用「当前用户」的那两个位置；
5. 写 `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Guncat Work`
   —— 即「应用和功能」里的那一项，包含 `UninstallString` / `QuietUninstallString` / `EstimatedSize`；
   同时清掉早期版本写在 `HKCU` 的那一份，免得出现两条；
6. **可选**：给 exe 挂 `RUNASADMIN` 兼容层（`HKLM\…\AppCompatFlags\Layers`）。默认不勾，
   本机排查表明「双击没反应」时需要它，见 `docs/STARTUP-TROUBLESHOOTING.md`。

只要目标目录能写就装得上；快捷方式或注册表写失败**不会**中断安装，只会记进日志。

## 卸载

`uninstall.exe`（或「设置 → 应用」里的卸载）会删除：应用文件、快捷方式、
「应用和功能」登记项、以及 `RUNASADMIN` 兼容层。默认**保留**用户数据
（`%APPDATA%\Guncat Work` 下的对话历史、工作区与 API 配置），
勾选「同时删除我的数据与配置」才会一并清掉。

卸载同样先自我提权，然后才交接给 `%TEMP%` 里的副本 —— 顺序很重要：
先提权再交接，临时副本就继承了管理员令牌，不会弹第二次 UAC。

## 日志

安装/卸载都写 `%TEMP%\Guncat-Work-Setup.log`；界面出错时会把该路径显示出来。
静默安装失败时这是唯一的线索。

## 分发前值得知道的几件事

1. **需要管理员授权**。机器级安装绕不开这件事：写 `C:\Program Files` 和 `HKLM` 都要提权。
   UAC 是默认的「同意」模式时，用户点一次「是」就行；如果对方用的是标准账户（不在管理员组），
   UAC 会要求**输入管理员账号密码** —— 那种环境下「当前用户安装」会更友好（见文件开头）。
2. **exe 没有签名**，所以别人第一次双击时 SmartScreen 大概率会拦一下
   （「Windows 已保护你的电脑 → 更多信息 → 仍要运行」）。要彻底消掉，得买代码签名证书，
   然后在 `scripts/package-installer.mjs` 里给两个 exe 各加一步 `signtool sign`。
3. **安装时会在 `%TEMP%` 释放一个 `7za.exe` 并执行它**（解压 385 MB 载荷用）。
   这是标准做法，但确实有杀软会因此报「可疑行为」。如果目标环境杀软很敏感，
   可以考虑改用 .NET 的 `ZipFile` 解压（体积会大 60 MB 左右、解压慢几倍），
   代价与收益见文件开头的说明。

## 静默安装（批量部署 / 自动化验证）

```bash
"release/Guncat-Work-0.2.1-setup.exe" --silent --dir "D:\Apps\Guncat Work"
"<安装目录>\uninstall.exe" --silent          # 默认保留用户数据
"<安装目录>\uninstall.exe" --silent --purge  # 连 %APPDATA%\Guncat Work 一起删
```

| 参数 | 作用 |
| --- | --- |
| `--silent` | 不建窗口，直接装/卸；成功退出码 0 |
| `--dir <路径>` | 指定安装/卸载目录 |
| `--no-launch` | 装完不自动启动 |
| `--no-desktop` / `--no-startmenu` | 不建对应快捷方式 |
| `--admin` | 安装时直接写入 `RUNASADMIN` 兼容层 |
| `--purge` | 卸载时连用户数据一起删（只有静默模式需要，界面上是勾选框） |
| `--no-elevate` | **仅供开发/CI**：不做提权，直接在当前令牌下装。装到 `Program Files` 之类的位置会失败，用于验证除提权外的全部流程 |
| `--shots <目录>` | 开发用：把各页面离屏渲染成 PNG 后退出 |
| `--from-temp` / `--wait-pid` | 卸载程序内部使用（见上） |

> 静默安装同样会提权，而提权后的进程是**另一个进程**：父进程会等它结束并把它的退出码带回来，
> 所以脚本能拿到真实结果。用户取消 UAC 时退出码是 3。

> **静默卸载是「交接完就返回」**：`uninstall.exe --silent` 把自己复制到 `%TEMP%`、拉起副本、
> 自己立刻退出 —— 退出码 0 只代表交接成功，真正的删除发生在副本里。
> 脚本要判断卸载是否完成，**请轮询安装目录是否消失**，不要只看退出码。
> （附带一个真实的坑：调用方若在同一个作业对象里、拉起后立刻退出，副本可能跟着被杀掉，
> 本次开发中就踩到过一次。）

## 改界面

界面全部在 `installer/src/*.xaml` 里。改完跑：

```bash
node scripts/package-installer.mjs --ui-only --shots
# → .tmp/installer-shots/*.png（安装 4 页 + 卸载 4 页）
```

`--ui-only` 跳过应用构建与 7z 压缩（省几分钟），只编界面并把每页渲染成 PNG。
渲染走 WPF 自己的 `RenderTargetBitmap`，**不需要真的开窗口**，因此在没有桌面会话的
环境里也能出图，是这套界面唯一的验证手段。

## 本机工具链约束（改代码前先看）

* 编译器是 **Windows 自带的 `csc.exe`（.NET Framework 4.8 目录下那个）**，
  它的语言版本是 **C# 5**：不能用字符串内插、`?.`、表达式体成员、`nameof`。
  这不是风格选择 —— 本机没有 dotnet SDK，也没有 VS/MSBuild，Roslyn 无处可取。
* XAML 是**运行时**由 `XamlReader.Load` 解析的，所以：
  * 不能写 `x:Class`、不能写事件属性（一律在 C# 里 `FindName` 后挂事件）；
  * `StaticResource` 依赖 `Application.Resources`（`Theme.Install()` 把 `theme.xaml` 挂上去）；
  * `Grid` 这类没有 `FontFamily` 属性的元素要用附加属性 `TextElement.FontFamily`。
* 引用程序集取自 `C:\Program Files (x86)\Reference Assemblies\…\.NETFramework\v4.x`，
  编译时带 `/noconfig`（否则 `csc.rsp` 会再引用一份运行时目录下的 `System.dll`，报 CS1703）。

## 文件一览

| 路径 | 作用 |
| --- | --- |
| `installer/src/theme.xaml` | 配色、字体、按钮/勾选框/输入框/进度条的 ControlTemplate |
| `installer/src/shell.xaml` | 窗口外壳：自定义标题栏 + 左侧品牌栏 + 页面宿主 |
| `installer/src/setup.xaml` / `setup.cs` | 安装程序四页与安装逻辑 |
| `installer/src/uninstall.xaml` / `uninstall.cs` | 卸载程序四页与卸载逻辑 |
| `installer/src/common.cs` | 资源装载、窗口外壳、快捷方式、注册表、日志、格式化 |
| `installer/app.manifest` | `asInvoker` + per-monitor DPI |
| `scripts/package-installer.mjs` | 构建入口：载荷 → 7z → 编译 → 产物 |

## 验证到哪一步了

| 项 | 结论 | 怎么验的 |
| --- | --- | --- |
| 静默安装 | ✅ 650 个文件 / 384.7 MB，约 6 秒 | `--silent --dir --no-elevate` 装完逐一核对目录结构 |
| 覆盖安装（装第二遍） | ✅ 同样 6 秒，无报错 | 连装两次，文件数与首次一致 |
| 静默卸载 | ✅ 安装目录、临时副本全部清干净 | 卸载后轮询目录消失 |
| 界面（安装 4 页 / 卸载 4 页） | ✅ | `--ui-only --shots` 离屏渲染 PNG |
| 真实窗口 | ✅ 1404×924 物理像素（150% DPI 下的 936×616 逻辑尺寸），圆角与透明边距正常 | 起窗口后按 DPI 感知方式截屏 |
| 安装位置默认值 | ✅ 解析出 `C:\Program Files\Guncat Work`（说明进程是 64 位，没被 Prefer32Bit 带成 `(x86)`） | 渲染出的选项页截图 |
| 目标不可写时的提示 | ✅ 非 0 退出 + 一句能照着做的人话，不是原始 .NET 异常 | 不提权直接装 `Program Files` |
| 快捷方式 COM 调用 | ✅ 能生成可解析的 `.lnk` | 同一段 `Shortcuts.Create` 单独驱动 |
| 提权后的写入（`Program Files` / `HKLM` / 公共桌面） | ⚠️ 未能实跑 | 需要真人点一次 UAC；开发机上的自动化环境给不了 |

最后一项不是代码问题而是环境限制：提权是一次交互式 UAC 授权，自动化里没人能点「是」。
其余每一步都跑过了，而且提权本身用 `--no-elevate` 绕过——它只跳过「换个令牌重新拉起自己」，
后面的写入逻辑是同一套代码。**在第一台真实机器上装一遍即可确认**，日志在
`%TEMP%\Guncat-Work-Setup.log`。

