// 安装程序与卸载程序共用的基础设施：
//   资源与 XAML 装载、窗口外壳、快捷方式、注册表、日志、格式化。
//
// 语言版本注意：本文件由 Windows 自带的 csc.exe（.NET 4.8，语言版本 C# 5）编译，
// 所以**不能**用字符串内插、?.、表达式体成员、nameof 等新语法。
// 这不是风格选择，是工具链约束 —— 见 installer/README.md「为什么不用 dotnet SDK」。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace GuncatSetup
{
    /// <summary>嵌入资源（XAML、图标、payload、7za、卸载器）的统一入口。</summary>
    static class Res
    {
        static Assembly Asm()
        {
            return Assembly.GetExecutingAssembly();
        }

        public static Stream Open(string name)
        {
            Stream s = Asm().GetManifestResourceStream(name);
            if (s == null) throw new InvalidOperationException("缺少嵌入资源：" + name);
            return s;
        }

        public static bool Has(string name)
        {
            return Asm().GetManifestResourceStream(name) != null;
        }

        /// <summary>解析一段嵌入的 XAML（不再是 x:Class 编译产物，运行时解析）。</summary>
        public static object LoadXaml(string name)
        {
            using (Stream s = Open(name))
            {
                return XamlReader.Load(s);
            }
        }

        /// <summary>从多尺寸 .ico 里挑最接近目标边长的帧，供窗口/标题栏使用。</summary>
        public static BitmapFrame LoadIconFrame(int want)
        {
            using (Stream s = Open("appicon.ico"))
            {
                BitmapDecoder dec = BitmapDecoder.Create(s, BitmapCreateOptions.PreservePixelFormat,
                                                         BitmapCacheOption.OnLoad);
                BitmapFrame best = dec.Frames[0];
                int bestDiff = int.MaxValue;
                foreach (BitmapFrame f in dec.Frames)
                {
                    int diff = Math.Abs(f.PixelWidth - want);
                    if (diff < bestDiff)
                    {
                        bestDiff = diff;
                        best = f;
                    }
                }
                return best;
            }
        }
    }

    /// <summary>把 theme.xaml 挂到 Application 上，各处 XAML 里的 StaticResource 才有得查。</summary>
    static class Theme
    {
        public static void Install(Application app)
        {
            ResourceDictionary dict = (ResourceDictionary)Res.LoadXaml("ThemeXaml");
            app.Resources.MergedDictionaries.Add(dict);
        }
    }

    /// <summary>显示用的格式化。</summary>
    static class Fmt
    {
        public static string Bytes(double b)
        {
            string[] units = new string[] { "B", "KB", "MB", "GB", "TB" };
            int i = 0;
            while (b >= 1024.0 && i < units.Length - 1)
            {
                b /= 1024.0;
                i++;
            }
            string num = b.ToString(i == 0 ? "0" : (b < 10.0 ? "0.0" : "0"), CultureInfo.InvariantCulture);
            return num + " " + units[i];
        }

        public static string Seconds(double s)
        {
            if (double.IsNaN(s) || double.IsInfinity(s) || s < 0 || s > 86400) return "—";
            int v = (int)Math.Round(s);
            if (v < 60) return v.ToString(CultureInfo.InvariantCulture) + " 秒";
            return (v / 60).ToString(CultureInfo.InvariantCulture) + " 分 " +
                   (v % 60).ToString(CultureInfo.InvariantCulture) + " 秒";
        }
    }

    /// <summary>文件系统相关的小工具。</summary>
    static class Fsx
    {
        /// <summary>递归求目录体积；途中出错就跳过，用于进度显示，不值得因此中断安装。</summary>
        public static long DirSize(string dir)
        {
            long total = 0;
            try
            {
                string[] files = Directory.GetFiles(dir);
                for (int i = 0; i < files.Length; i++)
                {
                    try { total += new FileInfo(files[i]).Length; }
                    catch { }
                }
                string[] dirs = Directory.GetDirectories(dir);
                for (int i = 0; i < dirs.Length; i++) total += DirSize(dirs[i]);
            }
            catch { }
            return total;
        }

        public static long FreeSpace(string dir)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(dir));
                return new DriveInfo(root).AvailableFreeSpace;
            }
            catch { return -1; }
        }

        public static void TryDeleteDir(string dir)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
            catch { }
        }

        /// <summary>
        /// 目标目录到底能不能写 —— 用于在用户点「开始安装」之前就给出提示，
        /// 而不是让他等界面上弹一个「访问被拒绝」。
        ///
        /// 探测方式：从目标往上找到第一个已存在的祖先，在那里建一个 DeleteOnClose 的探针文件。
        /// 不直接建目标目录本身，是因为那会在用户只是改了改路径时留下一个空目录。
        /// </summary>
        public static bool CanWriteDir(string dir)
        {
            try
            {
                string probe = dir;
                while (!string.IsNullOrEmpty(probe) && !Directory.Exists(probe))
                {
                    DirectoryInfo parent = Directory.GetParent(probe);
                    if (parent == null) return false;
                    probe = parent.FullName;
                }
                if (!Directory.Exists(probe)) return false;
                string file = Path.Combine(probe, ".guncat-write-probe-" + Guid.NewGuid().ToString("N"));
                FileStream fs = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1,
                                               FileOptions.DeleteOnClose);
                fs.Dispose();
                return true;
            }
            catch { return false; }
        }

        /// <summary>把流写成文件（用于把嵌入的 payload / 7za 释放到临时目录）。</summary>
        public static void CopyStream(Stream src, string dest)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None,
                                                  1024 * 512))
            {
                byte[] buf = new byte[1024 * 512];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) fs.Write(buf, 0, n);
            }
        }

        public static void CopyDir(string from, string to)
        {
            Directory.CreateDirectory(to);
            string[] files = Directory.GetFiles(from);
            for (int i = 0; i < files.Length; i++)
            {
                File.Copy(files[i], Path.Combine(to, Path.GetFileName(files[i])), true);
            }
            string[] dirs = Directory.GetDirectories(from);
            for (int i = 0; i < dirs.Length; i++)
            {
                CopyDir(dirs[i], Path.Combine(to, Path.GetFileName(dirs[i])));
            }
        }
    }

    /// <summary>快捷方式：走 WScript.Shell，省掉一整段 IShellLink COM 接口声明。</summary>
    static class Shortcuts
    {
        public static void Create(string lnkPath, string target, string args, string workDir, string iconPath,
                                  string description)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) throw new InvalidOperationException("系统里没有 WScript.Shell，无法创建快捷方式");
            dynamic shell = Activator.CreateInstance(t);
            dynamic lnk = shell.CreateShortcut(lnkPath);
            lnk.TargetPath = target;
            lnk.Arguments = args == null ? "" : args;
            lnk.WorkingDirectory = workDir == null ? "" : workDir;
            if (iconPath != null) lnk.IconLocation = iconPath;
            if (description != null) lnk.Description = description;
            lnk.Save();
        }

        /// <summary>
        /// 本项目是「为所有用户安装」，快捷方式一律放公共位置。
        /// 放在「当前用户」的桌面/开始菜单是不行的：提权后进程可能跑在另一个账户下
        /// （UAC 里输入了别的管理员账号时就是这样），那样快捷方式会跑到别人桌面上。
        /// </summary>
        public static string DesktopDir()
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
        }

        public static string StartMenuDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),
                                "Guncat Work");
        }

        /// <summary>早期版本装的是「当前用户」，卸载时要顺手清掉那些位置的残留。</summary>
        public static string PerUserDesktopDir()
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        }

        public static string PerUserStartMenuDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Guncat Work");
        }
    }

    /// <summary>
    /// 提权。清单里写的是 asInvoker（这样才可能用 runas 动词重新拉起自己），
    /// 要写 C:\Program Files 与 HKLM 就必须走这一步。
    /// </summary>
    static class Elevation
    {
        public static bool IsAdmin()
        {
            try
            {
                WindowsIdentity id = WindowsIdentity.GetCurrent();
                return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        public static string SelfPath()
        {
            return Assembly.GetExecutingAssembly().Location;
        }

        /// <summary>
        /// 用 runas 重新拉起自己（弹 UAC）。wait 为真时等它结束并把退出码带回来 ——
        /// 静默安装必须等，否则调用方拿不到真实结果。
        /// 返回 false 表示用户取消了 UAC，或系统不允许提权。
        /// </summary>
        public static bool RelaunchSelf(string arguments, bool wait, out int exitCode)
        {
            exitCode = 0;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(SelfPath());
                psi.Verb = "runas";
                psi.UseShellExecute = true;
                psi.Arguments = arguments;
                psi.WorkingDirectory = Path.GetDirectoryName(SelfPath());
                Process p = Process.Start(psi);
                if (wait && p != null)
                {
                    p.WaitForExit();
                    exitCode = p.ExitCode;
                }
                return true;
            }
            catch (Exception ex)
            {
                Logr.Write("提权重启失败：" + ex.Message);
                return false;
            }
        }

        /// <summary>把参数原样拼回命令行 —— 路径里的空格必须重新加引号。</summary>
        public static string BuildArgLine(string[] args)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) sb.Append(' ');
                string a = args[i];
                if (a.IndexOf(' ') >= 0 || a.IndexOf('\t') >= 0)
                {
                    sb.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
                }
                else
                {
                    sb.Append(a);
                }
            }
            return sb.ToString();
        }
    }

    /// <summary>
    /// 注册表。本产品是「为所有用户安装」，所以登记项、兼容层都写 HKLM（machine = true）；
    /// 保留 machine = false 的重载只是为了在卸载时顺手清掉早期版本的 HKCU 残留。
    /// </summary>
    static class Reg
    {
        public const string UninstallKey =
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Guncat Work";

        public const string CompatLayersKey =
            @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";

        static RegistryKey Root(bool machine)
        {
            return machine ? Registry.LocalMachine : Registry.CurrentUser;
        }

        public static void SetString(bool machine, string subKey, string name, string value)
        {
            using (RegistryKey k = Root(machine).CreateSubKey(subKey))
            {
                k.SetValue(name, value, RegistryValueKind.String);
            }
        }

        public static void SetDword(bool machine, string subKey, string name, int value)
        {
            using (RegistryKey k = Root(machine).CreateSubKey(subKey))
            {
                k.SetValue(name, value, RegistryValueKind.DWord);
            }
        }

        public static void DeleteTree(bool machine, string subKey)
        {
            try { Root(machine).DeleteSubKeyTree(subKey, false); }
            catch { }
        }

        public static void DeleteValue(bool machine, string subKey, string name)
        {
            try
            {
                using (RegistryKey k = Root(machine).OpenSubKey(subKey, true))
                {
                    if (k != null) k.DeleteValue(name, false);
                }
            }
            catch { }
        }

        public static string GetString(bool machine, string subKey, string name)
        {
            try
            {
                using (RegistryKey k = Root(machine).OpenSubKey(subKey))
                {
                    if (k == null) return null;
                    object v = k.GetValue(name);
                    return v == null ? null : v.ToString();
                }
            }
            catch { return null; }
        }
    }

    /// <summary>
    /// 安装/卸载过程的日志。GUI 程序没有控制台，静默安装更是什么都看不见 ——
    /// 出问题时这个文件是唯一的线索，所以从第一行就开始写。
    /// </summary>
    static class Logr
    {
        static readonly object gate = new object();
        static string path;

        public static string Path_
        {
            get
            {
                if (path == null)
                {
                    path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "Guncat-Work-Setup.log");
                }
                return path;
            }
        }

        public static void Write(string message)
        {
            lock (gate)
            {
                try
                {
                    File.AppendAllText(Path_,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) +
                        "  " + message + "\r\n", Encoding.UTF8);
                }
                catch { }
            }
        }

        public static void Reset()
        {
            lock (gate)
            {
                try { File.WriteAllText(Path_, "", Encoding.UTF8); }
                catch { }
            }
        }

        /// <summary>日志到底写没写成功 —— 界面上不该显示一个并不存在的路径。</summary>
        public static bool Exists
        {
            get
            {
                try { return File.Exists(Path_); }
                catch { return false; }
            }
        }
    }

    /// <summary>
    /// 窗口外壳：无边框 + 透明 + 圆角，标题栏自绘。
    /// 页面内容由调用方塞进 Host，品牌栏文字由调用方改写。
    /// </summary>
    class ShellWindow
    {
        public Window Win;
        public FrameworkElement Shell;
        public ContentControl Host;
        public Grid TitleBar;
        public Border BrandPanel;
        public ColumnDefinition BrandColumn;
        public Border BrandIcon;
        public Border TitleIcon;
        public TextBlock BrandName;
        public TextBlock BrandTagline;
        public TextBlock BrandVersion;
        public TextBlock TitleText;
        public Button BtnClose;
        public Button BtnMinimize;
        readonly double shadow = 18.0;

        public ShellWindow(bool compact)
        {
            Shell = (FrameworkElement)Res.LoadXaml("ShellXaml");
            Host = (ContentControl)Shell.FindName("PageHost");
            TitleBar = (Grid)Shell.FindName("TitleBar");
            BrandPanel = (Border)Shell.FindName("BrandPanel");
            BrandColumn = (ColumnDefinition)Shell.FindName("BrandColumn");
            BrandIcon = (Border)Shell.FindName("BrandIcon");
            TitleIcon = (Border)Shell.FindName("TitleIcon");
            BrandName = (TextBlock)Shell.FindName("BrandName");
            BrandTagline = (TextBlock)Shell.FindName("BrandTagline");
            BrandVersion = (TextBlock)Shell.FindName("BrandVersion");
            TitleText = (TextBlock)Shell.FindName("TitleText");
            BtnClose = (Button)Shell.FindName("BtnClose");
            BtnMinimize = (Button)Shell.FindName("BtnMinimize");

            // 两个图标用同一张图：品牌栏大图 + 标题栏小图
            BitmapFrame big = Res.LoadIconFrame(256);
            ImageBrush bigBrush = new ImageBrush(big);
            bigBrush.Stretch = Stretch.UniformToFill;
            BrandIcon.Background = bigBrush;

            BitmapFrame small = Res.LoadIconFrame(48);
            ImageBrush smallBrush = new ImageBrush(small);
            smallBrush.Stretch = Stretch.UniformToFill;
            TitleIcon.Background = smallBrush;

            if (compact)
            {
                // 卸载程序的窗口小一号：品牌栏窄一点，底部那三条产品说明也去掉
                BrandColumn.Width = new GridLength(240);
                Shell.Width = 740;
                Shell.Height = 486;
                StackPanel notes = (StackPanel)Shell.FindName("BrandNotes");
                if (notes != null) notes.Visibility = Visibility.Collapsed;
            }

            BtnClose.Click += delegate { OnCloseRequested(); };
            BtnMinimize.Click += delegate { Win.WindowState = WindowState.Minimized; };
            TitleBar.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed) Win.DragMove();
            };
            BrandPanel.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed) Win.DragMove();
            };

            Grid root = new Grid();
            root.Margin = new Thickness(shadow);
            root.Children.Add(Shell);

            Win = new Window();
            Win.WindowStyle = WindowStyle.None;
            Win.AllowsTransparency = true;
            Win.Background = Brushes.Transparent;
            Win.ResizeMode = ResizeMode.NoResize;
            Win.ShowInTaskbar = true;
            Win.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Win.Width = Shell.Width + shadow * 2;
            Win.Height = Shell.Height + shadow * 2;
            Win.Content = root;
            try { Win.Icon = Res.LoadIconFrame(48); }
            catch { }
        }

        /// <summary>关闭请求：先问一次是否真的要走（安装中不该被误关）。</summary>
        public Func<bool> ConfirmClose { get; set; }

        void OnCloseRequested()
        {
            if (ConfirmClose != null && !ConfirmClose()) return;
            Win.Close();
        }
    }
}
