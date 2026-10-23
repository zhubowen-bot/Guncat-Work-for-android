// 安装程序主体。
//
// 结构：
//   界面 = ShellWindow（无边框圆角窗）+ setup.xaml 的四页
//   安装 = RunInstall()，跑在后台线程上，通过 ProgressReport 回推进度
//   静默 = --silent，同样的流程但不建窗口，供自动化验证与批量部署使用
//
// 为什么解压要自己调 7za.exe 而不是用 .NET 的 ZipFile：
//   整包 380+ MB，deflate 与 LZMA2 的体积差在 60 MB 量级，解压速度也差好几倍。
//   7za.exe 由构建脚本从本机 electron-builder 的缓存里取，作为资源嵌进本 exe。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace GuncatSetup
{
    /// <summary>一次进度回推要更新的全部界面字段。</summary>
    class ProgressReport
    {
        public string Stage = "";
        public string Step = "";
        public string Detail = "";
        public string Speed = "";
        public double Percent = 0;
    }

    static class Program
    {
        static ShellWindow shell;
        static FrameworkElement pages;
        static TextBox txtDir;
        static TextBlock txtSpace;
        static CheckBox chkDesktop, chkStartMenu, chkLaunch, chkAdmin;
        static Grid pageOptions, pageProgress, pageDone, pageError;
        static TextBlock txtStep, txtStage, txtPercent, txtSpeed, txtDetail, txtDoneWhere, txtError,
            txtErrorLog, txtWarn;
        static ProgressBar barProgress;
        static Button btnInstall, btnCancel, btnAbort, btnLaunch, btnOpenDir, btnErrorClose, btnRetry;

        static volatile bool installRunning;
        static volatile bool cancelRequested;

        [STAThread]
        static void Main(string[] args)
        {
            // winexe 没有控制台，未捕获的异常会弹一个可能根本看不见的「已停止工作」框、
            // 进程就那样挂着 —— 所有路径都必须落盘。
            try
            {
                Run(args);
            }
            catch (Exception ex)
            {
                Fatal(ex);
            }
        }

        static void Fatal(Exception ex)
        {
            Logr.Write("致命错误：" + ex);
            try
            {
                string p = Path.Combine(
                    Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),
                    "setup-fatal.log");
                File.AppendAllText(p, DateTime.Now.ToString("s", CultureInfo.InvariantCulture) + "  " +
                                      ex.ToString() + "\r\n", Encoding.UTF8);
            }
            catch { }
            Environment.Exit(70);
        }

        static void Run(string[] args)
        {
            Options o = Options.Parse(args);
            Logr.Reset();
            Logr.Write("=== Guncat Work 安装程序启动 ===");
            Logr.Write("命令行：" + string.Join(" ", args));
            Logr.Write("版本：" + BuildInfo.Version + "  载荷：" + Fmt.Bytes(BuildInfo.PayloadBytes));

            // 本产品是「为所有用户安装」：要写 C:\Program Files、HKLM 与公共桌面，
            // 必须提权。清单里写的是 asInvoker（不然没法用 runas 重新拉起自己），
            // 于是这里自己判断、自己重启 —— 重启出来的那个进程才继续往下走。
            if (o.ShotDir == null && !o.NoElevate && !Elevation.IsAdmin())
            {
                Logr.Write("当前不是管理员，尝试提权重启");
                int code = 0;
                bool started = Elevation.RelaunchSelf(Elevation.BuildArgLine(args), o.Silent, out code);
                if (!started)
                {
                    // 用户在 UAC 上点了「否」。静默模式直接失败，界面模式给一句人话。
                    if (o.Silent)
                    {
                        Logr.Write("提权被拒绝，静默安装中止");
                        Environment.Exit(3);
                    }
                    MessageBox.Show(
                        "安装需要管理员权限（要把程序装到 " + DefaultDir() + "，并登记到「应用和功能」）。\n\n" +
                        "刚才的 UAC 请求被取消了，安装没有开始。",
                        "Guncat Work 安装程序", MessageBoxButton.OK, MessageBoxImage.Warning);
                    Environment.Exit(3);
                }
                Logr.Write("已提权重启，本进程退出");
                Environment.Exit(o.Silent ? code : 0);
            }

            // Application 在四条路径上都要有：主题资源挂在它身上，XAML 里的
            // StaticResource 才查得到（静默模式虽然不建窗口，留着也无害）。
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            Theme.Install(app);

            if (o.Silent)
            {
                if (o.Dir == null) o.Dir = DefaultDir();
                bool ok = SilentInstall(o);
                Environment.Exit(ok ? 0 : 1);
                return;
            }

            if (o.ShotDir != null)
            {
                RenderShots(o.ShotDir);
                return;
            }

            shell = new ShellWindow(false);
            shell.Win.Title = "Guncat Work 安装程序";
            shell.TitleText.Text = "Guncat Work 安装程序";
            shell.BrandVersion.Text = "v" + BuildInfo.Version;
            pages = (FrameworkElement)Res.LoadXaml("SetupXaml");
            shell.Host.Content = pages;
            BindElements();
            WireEvents();

            txtDir.Text = o.Dir != null ? o.Dir : DefaultDir();
            UpdateSpaceHint();
            shell.Win.Show();
            app.Run();
        }

        // ================= 参数 =================
        class Options
        {
            public string Dir;
            public bool Silent;
            public bool NoLaunch;
            public string ShotDir;
            public bool ForceAdmin;
            public bool NoDesktop;
            public bool NoStartMenu;
            public bool NoElevate;

            public static Options Parse(string[] args)
            {
                Options o = new Options();
                for (int i = 0; i < args.Length; i++)
                {
                    string a = args[i].ToLowerInvariant();
                    if (a == "--silent" || a == "/s") o.Silent = true;
                    else if (a == "--no-launch") o.NoLaunch = true;
                    else if (a == "--admin") o.ForceAdmin = true;
                    else if (a == "--no-desktop") o.NoDesktop = true;
                    else if (a == "--no-startmenu") o.NoStartMenu = true;
                    else if (a == "--no-elevate") o.NoElevate = true;
                    else if (a == "--dir" && i + 1 < args.Length) o.Dir = args[++i];
                    else if (a == "--shots" && i + 1 < args.Length) o.ShotDir = args[++i];
                }
                return o;
            }
        }

        static string DefaultDir()
        {
            // Program Files 而不是 %LOCALAPPDATA%\Programs：这是「为所有用户安装」，
            // 与 HKLM 登记项、公共桌面/开始菜单快捷方式配套。
            // 注意 exe 必须是 AnyCPU（64 位进程才拿得到 C:\Program Files 而不是 (x86)）。
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                                BuildInfo.DefaultDirName);
        }

        // ================= 界面装配 =================
        static void BindElements()
        {
            pageOptions = (Grid)pages.FindName("PageOptions");
            pageProgress = (Grid)pages.FindName("PageProgress");
            pageDone = (Grid)pages.FindName("PageDone");
            pageError = (Grid)pages.FindName("PageError");
            txtDir = (TextBox)pages.FindName("TxtDir");
            txtSpace = (TextBlock)pages.FindName("TxtSpace");
            txtWarn = (TextBlock)pages.FindName("TxtWarn");
            chkDesktop = (CheckBox)pages.FindName("ChkDesktop");
            chkStartMenu = (CheckBox)pages.FindName("ChkStartMenu");
            chkLaunch = (CheckBox)pages.FindName("ChkLaunch");
            chkAdmin = (CheckBox)pages.FindName("ChkAdmin");
            txtStep = (TextBlock)pages.FindName("TxtStep");
            txtStage = (TextBlock)pages.FindName("TxtStage");
            txtPercent = (TextBlock)pages.FindName("TxtPercent");
            txtSpeed = (TextBlock)pages.FindName("TxtSpeed");
            txtDetail = (TextBlock)pages.FindName("TxtDetail");
            txtDoneWhere = (TextBlock)pages.FindName("TxtDoneWhere");
            txtError = (TextBlock)pages.FindName("TxtError");
            txtErrorLog = (TextBlock)pages.FindName("TxtErrorLog");
            barProgress = (ProgressBar)pages.FindName("BarProgress");
            btnInstall = (Button)pages.FindName("BtnInstall");
            btnCancel = (Button)pages.FindName("BtnCancel");
            btnAbort = (Button)pages.FindName("BtnAbort");
            btnLaunch = (Button)pages.FindName("BtnLaunch");
            btnOpenDir = (Button)pages.FindName("BtnUninstallTip");
            btnErrorClose = (Button)pages.FindName("BtnErrorClose");
            btnRetry = (Button)pages.FindName("BtnRetry");
        }

        static void WireEvents()
        {
            Button browse = (Button)pages.FindName("BtnBrowse");
            browse.Click += delegate { Browse(); };
            btnInstall.Click += delegate { Install(); };
            btnCancel.Click += delegate { shell.Win.Close(); };
            btnAbort.Click += delegate { RequestCancel(); };
            btnLaunch.Click += delegate { Launch(); shell.Win.Close(); };
            btnOpenDir.Click += delegate { OpenDir(); };
            btnErrorClose.Click += delegate { shell.Win.Close(); };
            btnRetry.Click += delegate { Show(pageOptions); };
            txtDir.TextChanged += delegate { UpdateSpaceHint(); };
            shell.ConfirmClose = delegate { return !installRunning; };
        }

        static void Show(Grid page)
        {
            pageOptions.Visibility = page == pageOptions ? Visibility.Visible : Visibility.Collapsed;
            pageProgress.Visibility = page == pageProgress ? Visibility.Visible : Visibility.Collapsed;
            pageDone.Visibility = page == pageDone ? Visibility.Visible : Visibility.Collapsed;
            pageError.Visibility = page == pageError ? Visibility.Visible : Visibility.Collapsed;
        }

        static void Browse()
        {
            // WPF 自带的 Win32 文件夹对话框（.NET 4.8 里 System.Windows.Forms 也可用，
            // 但引一个 WinForms 程序集只为弹个目录选择框不值得）
            Microsoft.Win32.OpenFileDialog dlg = new Microsoft.Win32.OpenFileDialog();
            dlg.Title = "选择安装位置";
            dlg.ValidateNames = false;
            dlg.CheckFileExists = false;
            dlg.CheckPathExists = true;
            dlg.FileName = "选择此文件夹";
            try { dlg.InitialDirectory = txtDir.Text; }
            catch { }
            bool? ok = dlg.ShowDialog(shell.Win);
            if (ok == true)
            {
                string picked = Path.GetDirectoryName(dlg.FileName);
                if (!string.IsNullOrEmpty(picked))
                {
                    txtDir.Text = Path.Combine(picked, BuildInfo.DefaultDirName);
                    UpdateSpaceHint();
                }
            }
        }

        static void UpdateSpaceHint()
        {
            string dir = txtDir.Text;
            string text = "需要 " + Fmt.Bytes(BuildInfo.PayloadBytes);
            if (!string.IsNullOrEmpty(dir))
            {
                long free = Fsx.FreeSpace(dir);
                if (free >= 0)
                {
                    text += " · 该磁盘可用 " + Fmt.Bytes(free);
                    if (free < BuildInfo.PayloadBytes + 64L * 1024 * 1024)
                        text += "（空间可能不足）";
                }
            }
            txtSpace.Text = text;
            txtSpace.Foreground = (Brush)shell.Shell.FindResource("TextMuted");

            // 先探一次可写性：等用户点完「开始安装」再报「访问被拒绝」毫无帮助 ——
            // 他既不知道为什么，也不知道该做什么。（实测踩到过：从受限环境里启动时，
            // 目标目录整个写不进去，而界面只丢出一句原始的 .NET 异常。）
            bool writable = string.IsNullOrEmpty(dir) || Fsx.CanWriteDir(dir);
            txtWarn.Visibility = writable ? Visibility.Collapsed : Visibility.Visible;
            if (!writable)
            {
                txtWarn.Text = "这个位置当前写不进去，换一个位置即可（例如 D:\\Guncat Work）。";
            }
        }

        static void RequestCancel()
        {
            if (MessageBox.Show(shell.Win, "确定要取消安装吗？已解压的文件会被删除。", "取消安装",
                                MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes)
            {
                cancelRequested = true;
                btnAbort.IsEnabled = false;
                txtStep.Text = "正在取消…";
            }
        }

        // ================= 界面驱动的安装 =================
        static void Install()
        {
            string target = txtDir.Text == null ? "" : txtDir.Text.Trim().Trim('"');
            if (target.Length == 0)
            {
                MessageBox.Show(shell.Win, "请先选择安装位置。", "安装", MessageBoxButton.OK,
                                MessageBoxImage.Warning);
                return;
            }
            try { target = Path.GetFullPath(target); }
            catch
            {
                MessageBox.Show(shell.Win, "安装位置不是合法路径。", "安装", MessageBoxButton.OK,
                                MessageBoxImage.Warning);
                return;
            }

            Options o = new Options();
            o.Dir = target;
            o.NoLaunch = chkLaunch.IsChecked != true;
            o.NoDesktop = chkDesktop.IsChecked != true;
            o.NoStartMenu = chkStartMenu.IsChecked != true;
            o.ForceAdmin = chkAdmin.IsChecked == true;

            if (!EnsureAppClosed()) return;

            installRunning = true;
            cancelRequested = false;
            btnAbort.IsEnabled = true;
            SetProgress(new ProgressReport { Stage = "正在准备", Step = "准备安装…", Percent = 0 });
            Show(pageProgress);

            Thread t = new Thread(delegate ()
            {
                string error = null;
                try
                {
                    RunInstall(o, Report);
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                    Logr.Write("安装失败：" + ex);
                }
                installRunning = false;
                shell.Win.Dispatcher.Invoke(DispatcherPriority.Normal, new Action(delegate
                {
                    if (cancelRequested)
                    {
                        Show(pageOptions);
                        return;
                    }
                    if (error != null)
                    {
                        txtError.Text = error;
                        txtErrorLog.Text = Logr.Exists ? "详细日志：" + Logr.Path_ : "日志未能写入（%TEMP% 不可写）。";
                        Show(pageError);
                        return;
                    }
                    txtDoneWhere.Text = "Guncat Work " + BuildInfo.Version + " 已安装到：\n" + o.Dir;
                    Show(pageDone);
                    if (!o.NoLaunch) Launch();
                }));
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        static void Report(ProgressReport r)
        {
            if (shell == null) return;
            shell.Win.Dispatcher.Invoke(DispatcherPriority.Background, new Action(delegate { SetProgress(r); }));
        }

        static void SetProgress(ProgressReport r)
        {
            txtStage.Text = r.Stage;
            txtStep.Text = r.Step;
            txtDetail.Text = r.Detail;
            txtSpeed.Text = r.Speed;
            barProgress.Value = r.Percent;
            txtPercent.Text = ((int)Math.Round(r.Percent)).ToString(CultureInfo.InvariantCulture) + "%";
        }

        static void Launch()
        {
            string exe = Path.Combine(txtDir.Text.Trim().Trim('"'), BuildInfo.ExeName);
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe);
                psi.WorkingDirectory = Path.GetDirectoryName(exe);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(shell.Win, "启动失败：" + ex.Message, "Guncat Work", MessageBoxButton.OK,
                                MessageBoxImage.Warning);
            }
        }

        static void OpenDir()
        {
            try { Process.Start("explorer.exe", "\"" + txtDir.Text.Trim().Trim('"') + "\""); }
            catch { }
        }

        /// <summary>
        /// 目标里的 exe 正在运行的话，覆盖解压必然失败 —— 与其让 7za 报一个看不懂的错误，
        /// 不如先问一句。
        /// </summary>
        static bool EnsureAppClosed()
        {
            string name = Path.GetFileNameWithoutExtension(BuildInfo.ExeName);
            Process[] running = Process.GetProcessesByName(name);
            if (running.Length == 0) return true;
            MessageBoxResult r = MessageBox.Show(shell.Win,
                "Guncat Work 正在运行，安装前需要先关闭它。现在关闭吗？", "正在运行",
                MessageBoxButton.OKCancel, MessageBoxImage.Information);
            if (r != MessageBoxResult.OK) return false;
            for (int i = 0; i < running.Length; i++)
            {
                try { running[i].Kill(); running[i].WaitForExit(5000); }
                catch { }
            }
            Thread.Sleep(600);
            return true;
        }

        // ================= 静默安装 =================
        static bool SilentInstall(Options o)
        {
            Logr.Write("静默安装到 " + o.Dir);
            o.NoLaunch = true;   // 静默模式下是否启动由调用方自己决定
            try
            {
                RunInstall(o, delegate (ProgressReport r) { });
                Logr.Write("静默安装完成");
                return true;
            }
            catch (Exception ex)
            {
                Logr.Write("静默安装失败：" + ex);
                return false;
            }
        }

        // ================= 真正的安装流程 =================
        static void RunInstall(Options o, Action<ProgressReport> report)
        {
            string target = Path.GetFullPath(o.Dir);
            string temp = Path.Combine(Path.GetTempPath(), "GuncatWorkSetup-" + Process.GetCurrentProcess().Id);
            string payload = Path.Combine(temp, "payload.7z");
            string sevenZip = Path.Combine(temp, "7za.exe");

            ProgressReport r = new ProgressReport();

            // ---- 0. 目标目录 ----
            r.Stage = "正在准备";
            r.Step = "检查安装位置";
            r.Percent = 0;
            report(r);
            try
            {
                Directory.CreateDirectory(target);
            }
            catch (Exception ex)
            {
                // 直接把 .NET 那句「对路径…的访问被拒绝」丢给用户等于没说：
                // 他不明白为什么，也不知道下一步该做什么。
                throw new InvalidOperationException(
                    "无法创建安装目录：\n" + target + "\n\n" + ex.Message +
                    "\n\n请点「重试」换一个可以写入的位置（例如 D:\\Guncat Work）。");
            }
            if (!Fsx.CanWriteDir(target))
            {
                throw new InvalidOperationException(
                    "安装目录无法写入：\n" + target +
                    "\n\n请点「重试」换一个位置，或检查该目录的权限。");
            }
            long free = Fsx.FreeSpace(target);
            if (free >= 0 && free < BuildInfo.PayloadBytes + 32L * 1024 * 1024)
            {
                throw new InvalidOperationException(
                    "目标磁盘空间不足：需要约 " + Fmt.Bytes(BuildInfo.PayloadBytes) +
                    "，可用 " + Fmt.Bytes(free) + "。");
            }
            Fsx.TryDeleteDir(temp);
            Directory.CreateDirectory(temp);

            // ---- 1. 释放解压器与载荷 ----
            r.Stage = "正在准备";
            r.Step = "正在释放安装载荷";
            r.Percent = 1;
            report(r);
            using (Stream s = Res.Open("sevenzip")) Fsx.CopyStream(s, sevenZip);
            using (Stream s = Res.Open("payload")) Fsx.CopyStream(s, payload);

            // ---- 2. 解压到安装目录 ----
            r.Stage = "正在解压文件";
            r.Step = "正在写入 " + target;
            r.Detail = "共 " + BuildInfo.PayloadFiles.ToString(CultureInfo.InvariantCulture) + " 个文件";
            r.Percent = 2;
            report(r);

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = sevenZip;
            psi.Arguments = "x \"" + payload + "\" -o\"" + target + "\" -y -aoa -bd -bso0 -bsp0";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = temp;

            DateTime started = DateTime.Now;
            long totalBytes = BuildInfo.PayloadBytes;
            double lastBytes = 0;
            DateTime lastSample = started;
            Process p = Process.Start(psi);
            Logr.Write("7za 启动 pid=" + p.Id);
            while (!p.HasExited)
            {
                if (cancelRequested)
                {
                    try { p.Kill(); } catch { }
                    p.WaitForExit(5000);
                    Fsx.TryDeleteDir(target);
                    Fsx.TryDeleteDir(temp);
                    Logr.Write("用户取消了安装");
                    return;
                }
                Thread.Sleep(220);
                long done = Fsx.DirSize(target);
                // 走局部变量而不是直接比常量：常量比较会被编译器判成「恒真/恒假表达式」而告警
                double ratio = totalBytes <= 0 ? 0 : (double)done / totalBytes;
                if (ratio > 1) ratio = 1;
                DateTime now = DateTime.Now;
                double elapsed = (now - lastSample).TotalSeconds;
                double speed = 0;
                if (elapsed > 0.2)
                {
                    speed = (done - lastBytes) / elapsed;
                    lastBytes = done;
                    lastSample = now;
                }
                r.Percent = 2 + ratio * 88;
                r.Step = "正在解压 " + Fmt.Bytes(done) + " / " + Fmt.Bytes(totalBytes);
                r.Detail = "已解压 " + Fmt.Bytes(done);
                if (speed > 0)
                {
                    double remain = (totalBytes - done) / speed;
                    r.Speed = Fmt.Bytes(speed) + "/s · 剩余 " + Fmt.Seconds(remain);
                }
                report(r);
            }
            p.WaitForExit();
            int code = p.ExitCode;
            Logr.Write("7za 退出码 " + code);
            if (code != 0 && code != 1)
            {
                throw new InvalidOperationException("解压失败（7za 退出码 " + code + "）。日志：" + Logr.Path_);
            }
            string appExe = Path.Combine(target, BuildInfo.ExeName);
            if (!File.Exists(appExe))
            {
                throw new InvalidOperationException("解压完成但没找到 " + BuildInfo.ExeName + "，安装包可能已损坏。");
            }

            // ---- 3. 卸载器 ----
            r.Stage = "正在收尾";
            r.Step = "正在写入卸载程序";
            r.Percent = 92;
            report(r);
            string uninstaller = Path.Combine(target, "uninstall.exe");
            using (Stream s = Res.Open("uninstaller")) Fsx.CopyStream(s, uninstaller);

            // ---- 4. 快捷方式 ----
            //
            // 桌面/开始菜单写不进去（被策略拦、被别的进程占住…）不该让整个安装失败：
            // 应用本身已经落地能跑了，这里失败只记日志。
            r.Step = "正在创建快捷方式";
            r.Percent = 95;
            report(r);
            string desktopLnk = "";
            string startMenuDir = "";
            try
            {
                if (!o.NoDesktop)
                {
                    desktopLnk = Path.Combine(Shortcuts.DesktopDir(), BuildInfo.AppName + ".lnk");
                    Shortcuts.Create(desktopLnk, appExe, "", target, appExe, BuildInfo.AppName);
                }
                if (!o.NoStartMenu)
                {
                    startMenuDir = Shortcuts.StartMenuDir();
                    Directory.CreateDirectory(startMenuDir);
                    Shortcuts.Create(Path.Combine(startMenuDir, BuildInfo.AppName + ".lnk"), appExe, "", target,
                                     appExe, BuildInfo.AppName);
                    Shortcuts.Create(Path.Combine(startMenuDir, "卸载 " + BuildInfo.AppName + ".lnk"),
                                     uninstaller, "", target, uninstaller, "卸载 " + BuildInfo.AppName);
                }
            }
            catch (Exception ex)
            {
                Logr.Write("创建快捷方式失败：" + ex.Message);
            }

            // ---- 5. 注册表 ----
            r.Step = "正在登记到「应用和功能」";
            r.Percent = 97;
            report(r);
            WriteRegistry(target, appExe, uninstaller, desktopLnk, startMenuDir, o.ForceAdmin);

            // ---- 6. 清理 ----
            r.Step = "正在清理临时文件";
            r.Percent = 99;
            report(r);
            Fsx.TryDeleteDir(temp);

            r.Stage = "安装完成";
            r.Step = "全部完成";
            r.Detail = "";
            r.Speed = "";
            r.Percent = 100;
            report(r);
            Logr.Write("安装完成：" + target);
        }

        static void WriteRegistry(string target, string appExe, string uninstaller, string desktopLnk,
                                  string startMenuDir, bool adminCompat)
        {
            try
            {
                Reg.SetString(true, Reg.UninstallKey, "DisplayName", BuildInfo.AppName);
                Reg.SetString(true, Reg.UninstallKey, "DisplayVersion", BuildInfo.Version);
                Reg.SetString(true, Reg.UninstallKey, "Publisher", BuildInfo.Publisher);
                Reg.SetString(true, Reg.UninstallKey, "DisplayIcon", appExe);
                Reg.SetString(true, Reg.UninstallKey, "InstallLocation", target);
                Reg.SetString(true, Reg.UninstallKey, "UninstallString", "\"" + uninstaller + "\"");
                Reg.SetString(true, Reg.UninstallKey, "QuietUninstallString", "\"" + uninstaller + "\" --silent");
                Reg.SetString(true, Reg.UninstallKey, "InstallDate",
                              DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture));
                // 卸载时按这两条记录精确删除快捷方式：用户可能改过安装位置，
                // 也可能当初就没勾选桌面快捷方式，靠猜只会删错或删不干净。
                Reg.SetString(true, Reg.UninstallKey, "GuncatDesktopShortcut",
                              desktopLnk == null ? "" : desktopLnk);
                Reg.SetString(true, Reg.UninstallKey, "GuncatStartMenuDir",
                              startMenuDir == null ? "" : startMenuDir);
                Reg.SetDword(true, Reg.UninstallKey, "NoModify", 1);
                Reg.SetDword(true, Reg.UninstallKey, "NoRepair", 1);
                Reg.SetDword(true, Reg.UninstallKey, "EstimatedSize",
                             (int)Math.Min(int.MaxValue, BuildInfo.PayloadBytes / 1024));
                // 早期版本把登记项写在 HKCU：清掉，免得「应用和功能」里出现两条
                Reg.DeleteTree(false, Reg.UninstallKey);
            }
            catch (Exception ex)
            {
                // 登记失败不影响应用能不能用，但要在日志里说清楚，别让用户以为装坏了
                Logr.Write("写注册表（应用和功能）失败：" + ex.Message);
            }

            // AppCompatFlags：机器级安装就写 HKLM，对所有用户生效
            // （HKCU 那份是早期「当前用户安装」留下的，一并清掉）。
            // 这是「双击没反应」的最后一道保险，只有用户主动勾选才写。
            try
            {
                if (adminCompat)
                {
                    Reg.SetString(true, Reg.CompatLayersKey, appExe, "~ RUNASADMIN");
                    Logr.Write("已写入 RUNASADMIN 兼容层（HKLM）");
                }
                else
                {
                    Reg.DeleteValue(true, Reg.CompatLayersKey, appExe);
                }
                Reg.DeleteValue(false, Reg.CompatLayersKey, appExe);
            }
            catch (Exception ex)
            {
                Logr.Write("写兼容层失败：" + ex.Message);
            }
        }

        // ================= 开发用：把四个页面渲染成 PNG =================
        //
        // 界面的唯一验证手段。安装程序是 GUI，跑起来才能看到，而「看一眼」在自动化里不存在 ——
        // 这里用 WPF 自己的 RenderTargetBitmap 把页面离屏渲染出来，不需要窗口、不需要截屏。
        static void RenderShots(string dir)
        {
            Directory.CreateDirectory(dir);
            ShellWindow sh = new ShellWindow(false);
            sh.TitleText.Text = "Guncat Work 安装程序";
            sh.BrandVersion.Text = "v" + BuildInfo.Version;
            pages = (FrameworkElement)Res.LoadXaml("SetupXaml");
            sh.Host.Content = pages;
            shell = sh;

            pageOptions = (Grid)pages.FindName("PageOptions");
            pageProgress = (Grid)pages.FindName("PageProgress");
            pageDone = (Grid)pages.FindName("PageDone");
            pageError = (Grid)pages.FindName("PageError");
            txtDir = (TextBox)pages.FindName("TxtDir");
            txtSpace = (TextBlock)pages.FindName("TxtSpace");
            txtWarn = (TextBlock)pages.FindName("TxtWarn");
            txtStep = (TextBlock)pages.FindName("TxtStep");
            txtStage = (TextBlock)pages.FindName("TxtStage");
            txtPercent = (TextBlock)pages.FindName("TxtPercent");
            txtSpeed = (TextBlock)pages.FindName("TxtSpeed");
            txtDetail = (TextBlock)pages.FindName("TxtDetail");
            txtDoneWhere = (TextBlock)pages.FindName("TxtDoneWhere");
            txtError = (TextBlock)pages.FindName("TxtError");
            txtErrorLog = (TextBlock)pages.FindName("TxtErrorLog");
            barProgress = (ProgressBar)pages.FindName("BarProgress");

            FrameworkElement root = (FrameworkElement)sh.Win.Content;

            txtDir.Text = DefaultDir();
            UpdateSpaceHint();
            // 截图是给文档用的，要的是「一切正常」的样子。可写性探测在受限环境里会返回 false，
            // 于是这里强制收掉那条警告（真实运行该显示就显示）。
            txtWarn.Visibility = Visibility.Collapsed;
            // 界面模式下没编载荷，UpdateSpaceHint 会算出「需要 0 B」，预览里看着像坏了 —— 给个真值
            // （经局部变量比较：直接比常量会被编译器判成恒假而报「无法访问的代码」）
            long previewPayload = BuildInfo.PayloadBytes;
            if (previewPayload <= 0)
            {
                txtSpace.Text = "需要 384.5 MB · 该磁盘可用 401.3 GB";
            }

            SetProgress(new ProgressReport
            {
                Stage = "正在解压文件",
                Step = "正在解压 214.7 MB / 384.5 MB",
                Detail = "已解压 214.7 MB",
                Speed = "18.6 MB/s · 剩余 21 秒",
                Percent = 56
            });
            Shot(root, sh, pageOptions, Path.Combine(dir, "1-options.png"));
            Shot(root, sh, pageProgress, Path.Combine(dir, "2-progress.png"));

            txtDoneWhere.Text = "Guncat Work " + BuildInfo.Version + " 已安装到：\n" + DefaultDir();
            Shot(root, sh, pageDone, Path.Combine(dir, "3-done.png"));

            txtError.Text = "目标磁盘空间不足：需要约 384.5 MB，可用 122.0 MB。";
            txtErrorLog.Text = "详细日志：" + Logr.Path_;
            Shot(root, sh, pageError, Path.Combine(dir, "4-error.png"));
            Environment.Exit(0);
        }

        static void Shot(FrameworkElement root, ShellWindow sh, Grid page, string file)
        {
            Show(page);
            double w = sh.Win.Width;
            double h = sh.Win.Height;
            // 深色桌面底：阴影只有在有背景时才看得出来，透明 PNG 直接看会以为是缺了一块
            DrawingVisual bg = new DrawingVisual();
            using (DrawingContext dc = bg.RenderOpen())
            {
                LinearGradientBrush b = new LinearGradientBrush();
                b.StartPoint = new Point(0, 0);
                b.EndPoint = new Point(1, 1);
                b.GradientStops.Add(new GradientStop(Color.FromRgb(0x1A, 0x1F, 0x27), 0));
                b.GradientStops.Add(new GradientStop(Color.FromRgb(0x0B, 0x0E, 0x14), 1));
                dc.DrawRectangle(b, null, new Rect(0, 0, w, h));
            }
            root.Width = w;
            root.Height = h;
            root.Measure(new Size(w, h));
            root.Arrange(new Rect(0, 0, w, h));
            root.UpdateLayout();

            RenderTargetBitmap rtb = new RenderTargetBitmap((int)Math.Ceiling(w), (int)Math.Ceiling(h), 96, 96,
                                                            PixelFormats.Pbgra32);
            rtb.Render(root);

            DrawingVisual dv = new DrawingVisual();
            using (DrawingContext dc = dv.RenderOpen())
            {
                dc.DrawImage(rtb, new Rect(0, 0, w, h));
            }
            // 背景先画、窗口后画：两个视觉对象按 Z 序叠加
            RenderTargetBitmap flat = new RenderTargetBitmap((int)Math.Ceiling(w), (int)Math.Ceiling(h), 96, 96,
                                                             PixelFormats.Pbgra32);
            flat.Render(bg);
            flat.Render(dv);

            PngBitmapEncoder enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(flat));
            using (FileStream fs = new FileStream(file, FileMode.Create, FileAccess.Write))
            {
                enc.Save(fs);
            }
            Console.WriteLine("shot: " + file);
        }
    }
}
