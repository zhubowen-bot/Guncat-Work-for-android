// 卸载程序。
//
// 为什么要先把自己拷到 %TEMP% 再跑：
//   本 exe 就在要删除的那棵树里。Windows 不允许删除正在运行的映像，
//   所以「确认/进度」这些界面必须由一个位于别处的进程来显示，否则等到删自己时必然失败。
//   这是 NSIS / Inno 都在用的同一套办法。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace GuncatSetup
{
    static class Program
    {
        static ShellWindow shell;
        static FrameworkElement pages;
        static Grid pageConfirm, pageProgress, pageDone, pageError;
        static TextBlock txtTarget, txtStep, txtStage, txtPercent, txtDone, txtError, txtErrorLog;
        static ProgressBar barProgress;
        static CheckBox chkData;
        static Button btnRemove, btnCancel, btnDone, btnErrorClose;

        static string installDir;
        static bool deleteData;
        static int waitPid;

        [STAThread]
        static void Main(string[] args)
        {
            Options o = Options.Parse(args);
            Logr.Reset();
            Logr.Write("=== Guncat Work 卸载程序启动 ===");
            Logr.Write("命令行：" + string.Join(" ", args));

            installDir = o.Dir != null ? Path.GetFullPath(o.Dir)
                                       : Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            waitPid = o.WaitPid;

            // 卸载要删 C:\Program Files 下的文件、写 HKLM、清公共桌面快捷方式，同样必须提权。
            // 提权放在「交接给临时副本」之前：这样临时副本天然继承提权后的令牌，
            // 不必再弹第二次 UAC。
            //
            // `!o.FromTemp` 那一项不是可有可无：临时副本在 %TEMP% 里，如果让它再去提权，
            // Windows 会在 UAC 之前先弹一个「打开文件 - 安全警告」（位置不可信），
            // 而且它是无人应答就卡住的模态框 —— 实测踩到过。既然交接前必定已提权，
            // 副本就永远不需要自己提权。
            if (o.ShotDir == null && !o.FromTemp && !o.NoElevate && !Elevation.IsAdmin())
            {
                Logr.Write("当前不是管理员，尝试提权重启");
                int code = 0;
                if (!Elevation.RelaunchSelf(Elevation.BuildArgLine(args), o.Silent, out code))
                {
                    if (o.Silent)
                    {
                        Logr.Write("提权被拒绝，静默卸载中止");
                        Environment.Exit(3);
                    }
                    MessageBox.Show("卸载需要管理员权限。\n\n刚才的 UAC 请求被取消了，卸载没有开始。",
                                    "Guncat Work", MessageBoxButton.OK, MessageBoxImage.Warning);
                    Environment.Exit(3);
                }
                Logr.Write("已提权重启，本进程退出");
                Environment.Exit(o.Silent ? code : 0);
            }

            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            Theme.Install(app);

            if (o.ShotDir == null && !o.FromTemp)
            {
                // 静默模式也必须交接：本 exe 就在要删的目录里，
                // 留在原地跑的话最后一定删不掉自己（第一版就是这么错的）。
                HandOffToTemp(o);
                return;
            }

            if (o.Silent)
            {
                // 静默模式没有勾选框，是否连数据一起删由 --purge 决定（默认保留，与界面默认一致）
                deleteData = o.Purge;
                bool ok = false;
                try
                {
                    ok = RunUninstall(delegate (long done, long total, string what) { });
                }
                catch (Exception ex)
                {
                    Logr.Write("静默卸载失败：" + ex);
                }
                Logr.Write(ok ? "静默卸载完成" : "静默卸载未完成");
                Environment.Exit(ok ? 0 : 2);
                return;
            }

            if (o.ShotDir != null)
            {
                RenderShots(o.ShotDir);
                return;
            }

            BuildUi();
            app.Run();
        }

        class Options
        {
            public string Dir;
            public bool FromTemp;
            public bool Silent;
            public bool Purge;
            public bool NoElevate;
            public string ShotDir;
            public int WaitPid;

            public static Options Parse(string[] a)
            {
                Options o = new Options();
                for (int i = 0; i < a.Length; i++)
                {
                    string s = a[i].ToLowerInvariant();
                    if (s == "--dir" && i + 1 < a.Length) o.Dir = a[++i];
                    else if (s == "--from-temp") o.FromTemp = true;
                    else if (s == "--silent" || s == "/s") o.Silent = true;
                    else if (s == "--purge") o.Purge = true;
                    else if (s == "--no-elevate") o.NoElevate = true;
                    else if (s == "--shots" && i + 1 < a.Length) o.ShotDir = a[++i];
                    else if (s == "--wait-pid" && i + 1 < a.Length) int.TryParse(a[++i], out o.WaitPid);
                }
                return o;
            }
        }

        /// <summary>把自己复制到临时目录并以 --from-temp 重新拉起，然后立刻退出。</summary>
        static void HandOffToTemp(Options o)
        {
            try
            {
                string self = Assembly.GetExecutingAssembly().Location;
                string temp = Path.Combine(Path.GetTempPath(),
                                           "guncat-uninstall-" + Process.GetCurrentProcess().Id + ".exe");
                File.Copy(self, temp, true);
                ProcessStartInfo psi = new ProcessStartInfo(temp);
                psi.Arguments = "--from-temp --dir \"" + installDir + "\" --wait-pid " +
                                Process.GetCurrentProcess().Id +
                                (o.Silent ? " --silent" : "") + (o.Purge ? " --purge" : "");
                psi.UseShellExecute = false;
                psi.WorkingDirectory = Path.GetTempPath();
                Process.Start(psi);
                Logr.Write("已交接给临时副本：" + temp);
            }
            catch (Exception ex)
            {
                Logr.Write("交接给临时副本失败：" + ex.Message);
                MessageBox.Show("无法启动卸载程序：\n" + ex.Message, "Guncat Work",
                                MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        // ================= 界面 =================
        static void BuildUi()
        {
            shell = new ShellWindow(true);
            shell.Win.Title = "卸载 Guncat Work";
            shell.TitleText.Text = "卸载 Guncat Work";
            shell.BrandName.Text = "Guncat Work";
            shell.BrandTagline.Text = "电脑版 · 卸载程序";
            shell.BrandVersion.Text = "v" + BuildInfo.Version;
            pages = (FrameworkElement)Res.LoadXaml("UninstallXaml");
            shell.Host.Content = pages;

            pageConfirm = (Grid)pages.FindName("PageConfirm");
            pageProgress = (Grid)pages.FindName("PageProgress");
            pageDone = (Grid)pages.FindName("PageDone");
            pageError = (Grid)pages.FindName("PageError");
            txtTarget = (TextBlock)pages.FindName("TxtTarget");
            txtStep = (TextBlock)pages.FindName("TxtStep");
            txtStage = (TextBlock)pages.FindName("TxtStage");
            txtPercent = (TextBlock)pages.FindName("TxtPercent");
            txtDone = (TextBlock)pages.FindName("TxtDone");
            txtError = (TextBlock)pages.FindName("TxtError");
            txtErrorLog = (TextBlock)pages.FindName("TxtErrorLog");
            barProgress = (ProgressBar)pages.FindName("BarProgress");
            chkData = (CheckBox)pages.FindName("ChkData");
            btnRemove = (Button)pages.FindName("BtnRemove");
            btnCancel = (Button)pages.FindName("BtnCancel");
            btnDone = (Button)pages.FindName("BtnDone");
            btnErrorClose = (Button)pages.FindName("BtnErrorClose");

            txtTarget.Text = installDir;
            TextBlock hint = (TextBlock)pages.FindName("TxtDataHint");
            hint.Text = "包含对话历史、沙箱工作区与 API 配置，位于 " + DataDir();

            btnCancel.Click += delegate { shell.Win.Close(); };
            btnDone.Click += delegate { shell.Win.Close(); };
            btnErrorClose.Click += delegate { shell.Win.Close(); };
            btnRemove.Click += delegate { StartUninstall(); };
            shell.Win.Show();
        }

        static void Show(Grid page)
        {
            pageConfirm.Visibility = page == pageConfirm ? Visibility.Visible : Visibility.Collapsed;
            pageProgress.Visibility = page == pageProgress ? Visibility.Visible : Visibility.Collapsed;
            pageDone.Visibility = page == pageDone ? Visibility.Visible : Visibility.Collapsed;
            pageError.Visibility = page == pageError ? Visibility.Visible : Visibility.Collapsed;
        }

        static void StartUninstall()
        {
            deleteData = chkData.IsChecked == true;
            Show(pageProgress);
            Thread t = new Thread(delegate ()
            {
                string error = null;
                try
                {
                    RunUninstall(delegate (long done, long total, string what)
                    {
                        double pct = total <= 0 ? 0 : (double)done / total * 100.0;
                        shell.Win.Dispatcher.Invoke(DispatcherPriority.Background, new Action(delegate
                        {
                            barProgress.Value = pct;
                            txtPercent.Text = ((int)Math.Round(pct)).ToString(CultureInfo.InvariantCulture) + "%";
                            txtStep.Text = what;
                        }));
                    });
                }                catch (Exception ex)
                {
                    error = ex.Message;
                    Logr.Write("卸载失败：" + ex);
                }
                shell.Win.Dispatcher.Invoke(DispatcherPriority.Normal, new Action(delegate
                {
                    if (error != null)
                    {
                        txtError.Text = error;
                        txtErrorLog.Text = "详细日志：" + Logr.Path_;
                        Show(pageError);
                        return;
                    }
                    txtDone.Text = deleteData
                        ? "Guncat Work 已移除，本地数据与配置也已删除。"
                        : "Guncat Work 已从这台电脑上移除，你的对话历史与配置保留在 " + DataDir() + "。";
                    Show(pageDone);
                }));
            });
            t.IsBackground = true;
            t.Start();
        }

        static string DataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                                "Guncat Work");
        }

        // ================= 真正的卸载 =================
        delegate void DeleteReport(long done, long total, string what);

        /// <summary>返回是否已经把安装目录清干净 —— 静默模式的退出码看它。</summary>
        static bool RunUninstall(DeleteReport report)
        {
            // 先从注册表里把安装时记下的信息读出来 —— 那些键马上就会被删掉。
            // 主记录在 HKLM（机器级安装）；HKCU 那份是早期「当前用户安装」的遗留，一并兜底。
            string desktopLnk = Reg.GetString(true, Reg.UninstallKey, "GuncatDesktopShortcut");
            string startMenuDir = Reg.GetString(true, Reg.UninstallKey, "GuncatStartMenuDir");
            string registered = Reg.GetString(true, Reg.UninstallKey, "InstallLocation");
            if (string.IsNullOrEmpty(desktopLnk))
                desktopLnk = Reg.GetString(false, Reg.UninstallKey, "GuncatDesktopShortcut");
            if (string.IsNullOrEmpty(startMenuDir))
                startMenuDir = Reg.GetString(false, Reg.UninstallKey, "GuncatStartMenuDir");
            if (string.IsNullOrEmpty(registered))
                registered = Reg.GetString(false, Reg.UninstallKey, "InstallLocation");
            if (!string.IsNullOrEmpty(registered) && Directory.Exists(registered)) installDir = registered;

            report(0, 100, "正在关闭 Guncat Work…");
            WaitForParent();
            KillRunning();
            Thread.Sleep(300);

            // 先数一遍，进度才有分母
            long totalBytes = 0;
            int totalFiles = 0;
            CountTree(installDir, ref totalBytes, ref totalFiles);
            Logr.Write("待删除：" + totalFiles + " 个文件 / " + Fmt.Bytes(totalBytes));

            long doneBytes = 0;
            int doneFiles = 0;
            DeleteTree(installDir, ref doneBytes, ref doneFiles, totalBytes, totalFiles, report);

            report(totalBytes, totalBytes, "正在清理快捷方式与注册表…");
            string exeInDir = Path.Combine(installDir, BuildInfo.ExeName);
            // 公共位置（当前安装方式）+ 当前用户位置（早期版本）+ 安装时记下的确切路径：
            // 三个都试一遍，删不存在的只是空转，比漏删干净。
            TryDeleteFile(Path.Combine(Shortcuts.DesktopDir(), BuildInfo.AppName + ".lnk"));
            TryDeleteFile(Path.Combine(Shortcuts.PerUserDesktopDir(), BuildInfo.AppName + ".lnk"));
            if (!string.IsNullOrEmpty(desktopLnk)) TryDeleteFile(desktopLnk);
            TryDeleteDir(Shortcuts.StartMenuDir());
            TryDeleteDir(Shortcuts.PerUserStartMenuDir());
            if (!string.IsNullOrEmpty(startMenuDir)) TryDeleteDir(startMenuDir);
            Reg.DeleteValue(true, Reg.CompatLayersKey, exeInDir);
            Reg.DeleteValue(false, Reg.CompatLayersKey, exeInDir);
            Reg.DeleteTree(true, Reg.UninstallKey);
            Reg.DeleteTree(false, Reg.UninstallKey);

            if (deleteData)
            {
                report(totalBytes, totalBytes + 1, "正在删除本地数据…");
                TryDeleteDir(DataDir());
            }

            // 安装目录本身（此刻应该已经空了 —— 除了刚刚被交接出去的那个 uninstall.exe）
            bool gone = RemoveTreeWithRetry(installDir);

            Logr.Write(gone ? "卸载完成：" + installDir : "安装目录仍有残留：" + installDir);
            SelfDestruct();
            return gone;
        }

        /// <summary>
        /// 等交接前那个进程退出。它可能还在收尾（父进程是在 Process.Start 之后立刻 return 的，
        /// 但 Windows 回收进程句柄有延迟），不等的话删 uninstall.exe 会撞上「访问被拒绝」。
        /// </summary>
        static void WaitForParent()
        {
            if (waitPid <= 0) return;
            try
            {
                Process parent = Process.GetProcessById(waitPid);
                if (!parent.WaitForExit(15000)) Logr.Write("等待父进程退出超时");
            }
            catch
            {
                // 已经退出了：GetProcessById 会抛，正是我们想要的状态
            }
        }

        /// <summary>整目录删除带重试：文件锁的释放是异步的，一次失败不代表删不掉。</summary>
        static bool RemoveTreeWithRetry(string dir)
        {
            for (int i = 0; i < 12; i++)
            {
                try
                {
                    if (!Directory.Exists(dir)) return true;
                    Directory.Delete(dir, true);
                    if (!Directory.Exists(dir)) return true;
                }
                catch (Exception ex)
                {
                    Logr.Write("删除安装目录第 " + (i + 1) + " 次失败：" + ex.Message);
                }
                Thread.Sleep(400);
            }
            return !Directory.Exists(dir);
        }

        static void KillRunning()
        {
            Process[] ps = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(BuildInfo.ExeName));
            for (int i = 0; i < ps.Length; i++)
            {
                try { ps[i].Kill(); ps[i].WaitForExit(4000); }
                catch { }
            }
        }

        static void CountTree(string dir, ref long bytes, ref int files)
        {
            if (!Directory.Exists(dir)) return;
            try
            {
                string[] fs = Directory.GetFiles(dir);
                files += fs.Length;
                for (int i = 0; i < fs.Length; i++)
                {
                    try { bytes += new FileInfo(fs[i]).Length; }
                    catch { }
                }
                string[] ds = Directory.GetDirectories(dir);
                for (int i = 0; i < ds.Length; i++) CountTree(ds[i], ref bytes, ref files);
            }
            catch { }
        }

        /// <summary>逐文件删除并回报进度 —— 整树 Directory.Delete 是黑盒，进度条只能干等。</summary>
        static void DeleteTree(string dir, ref long doneBytes, ref int doneFiles, long totalBytes,
                               int totalFiles, DeleteReport report)
        {
            if (!Directory.Exists(dir)) return;
            string[] files;
            try { files = Directory.GetFiles(dir); }
            catch { files = new string[0]; }
            for (int i = 0; i < files.Length; i++)
            {
                long size = 0;
                try { size = new FileInfo(files[i]).Length; } catch { }
                bool ok = TryDeleteFile(files[i]);
                if (ok)
                {
                    doneBytes += size;
                    doneFiles++;
                }
                if (doneFiles % 8 == 0 || doneFiles == totalFiles)
                {
                    report(doneBytes, totalBytes, "正在删除文件（" + doneFiles + " / " + totalFiles + "）");
                }
            }
            string[] dirs;
            try { dirs = Directory.GetDirectories(dir); }
            catch { dirs = new string[0]; }
            for (int i = 0; i < dirs.Length; i++)
            {
                DeleteTree(dirs[i], ref doneBytes, ref doneFiles, totalBytes, totalFiles, report);
            }
            try { Directory.Delete(dir, false); }
            catch { }
        }

        static bool TryDeleteFile(string path)
        {
            try
            {
                if (!File.Exists(path)) return false;
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(path);
                return true;
            }
            catch (Exception ex)
            {
                Logr.Write("删除失败 " + path + "：" + ex.Message);
                return false;
            }
        }

        static void TryDeleteDir(string dir)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
            catch (Exception ex) { Logr.Write("删除目录失败 " + dir + "：" + ex.Message); }
        }

        /// <summary>
        /// 删掉临时目录里的自己。正在运行的映像删不掉，所以交给一个隐藏的 cmd
        /// 等本进程退出后再删 —— 除此之外没有更好的办法。
        /// </summary>
        static void SelfDestruct()
        {
            try
            {
                string self = Assembly.GetExecutingAssembly().Location;
                if (self.IndexOf(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase) != 0) return;
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                psi.Arguments = "/c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch { }
        }

        // ================= 开发用：页面渲染 =================
        static void RenderShots(string dir)
        {
            Directory.CreateDirectory(dir);
            ShellWindow sh = new ShellWindow(true);
            sh.TitleText.Text = "卸载 Guncat Work";
            sh.BrandTagline.Text = "电脑版 · 卸载程序";
            sh.BrandVersion.Text = "v" + BuildInfo.Version;
            pages = (FrameworkElement)Res.LoadXaml("UninstallXaml");
            sh.Host.Content = pages;
            shell = sh;

            pageConfirm = (Grid)pages.FindName("PageConfirm");
            pageProgress = (Grid)pages.FindName("PageProgress");
            pageDone = (Grid)pages.FindName("PageDone");
            pageError = (Grid)pages.FindName("PageError");
            txtTarget = (TextBlock)pages.FindName("TxtTarget");
            txtStep = (TextBlock)pages.FindName("TxtStep");
            txtStage = (TextBlock)pages.FindName("TxtStage");
            txtPercent = (TextBlock)pages.FindName("TxtPercent");
            txtDone = (TextBlock)pages.FindName("TxtDone");
            txtError = (TextBlock)pages.FindName("TxtError");
            txtErrorLog = (TextBlock)pages.FindName("TxtErrorLog");
            barProgress = (ProgressBar)pages.FindName("BarProgress");
            chkData = (CheckBox)pages.FindName("ChkData");

            ((TextBlock)pages.FindName("TxtDataHint")).Text =
                "包含对话历史、沙箱工作区与 API 配置，位于 " + DataDir();
            txtTarget.Text = Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData), "Programs", BuildInfo.DefaultDirName);

            FrameworkElement root = (FrameworkElement)sh.Win.Content;
            Shot(root, sh, pageConfirm, Path.Combine(dir, "u1-confirm.png"));

            barProgress.Value = 64;
            txtPercent.Text = "64%";
            txtStep.Text = "正在删除文件（192 / 300）";
            Shot(root, sh, pageProgress, Path.Combine(dir, "u2-progress.png"));

            txtDone.Text = "Guncat Work 已从这台电脑上移除，你的对话历史与配置保留在 " + DataDir() + "。";
            Shot(root, sh, pageDone, Path.Combine(dir, "u3-done.png"));

            txtError.Text = "删除失败：文件被另一个程序占用。";
            txtErrorLog.Text = "详细日志：" + Logr.Path_;
            Shot(root, sh, pageError, Path.Combine(dir, "u4-error.png"));
        }

        static void Shot(FrameworkElement root, ShellWindow sh, Grid page, string file)
        {
            Show(page);
            double w = sh.Win.Width;
            double h = sh.Win.Height;
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
            using (DrawingContext dc = dv.RenderOpen()) dc.DrawImage(rtb, new Rect(0, 0, w, h));
            RenderTargetBitmap flat = new RenderTargetBitmap((int)Math.Ceiling(w), (int)Math.Ceiling(h), 96, 96,
                                                             PixelFormats.Pbgra32);
            flat.Render(bg);
            flat.Render(dv);

            PngBitmapEncoder enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(flat));
            using (FileStream fs = new FileStream(file, FileMode.Create, FileAccess.Write)) enc.Save(fs);
            Console.WriteLine("shot: " + file);
        }
    }
}
