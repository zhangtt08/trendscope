// TrendScope 桌面外壳(原生 exe)。
//
// 为什么不用 Tauri:Electron/Tauri 都要额外几百 MB,而这台机器只装了 MSVC 工具集、
// 没装 Windows SDK,Rust 链接一律 LNK1181。Windows 自带 C# 编译器(csc),
// 使用者机器上也已经有 WebView2 Runtime,所以这里用 WinForms + WebView2 控件,
// 编译出真正的 TrendScope.exe —— 不装新工具链、不要管理员权限。
//
// 职责和 Rust 版一致,而且刻意做得很小:
//  1. 从 exe 所在目录往上找项目根(package.json + dist-server/index.js);
//  2. 端口没人监听就起一个 node,并等它真的能连上再导航(否则先看到"拒绝连接");
//  3. 窗口关掉时,把自己起的那个 node 一起带走,不留孤儿进程占着端口和数据库;
//  4. 起不来时不白屏 —— 显示一页中文说明,写清楚下一步能做什么。
//
// 窗口外观:无边框 + 自绘标题栏(最小化/最大化/关闭三键内嵌在软件内部),
// 标题栏区域经 WM_NCHITTEST 返回 HTCAPTION,拖拽/双击最大化/Win+方向贴靠走系统原生行为。
//
// 注意:源码里有中文,编译必须带 /codepage:65001,否则 csc 会按本机 ANSI 码页读,
// 窗口标题和提示语会变成乱码。编译目标是 .NET Framework 4 自带 csc,语法保持 C# 5。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TrendScope
{
    static class Program
    {
        static Process node;
        static string userDataFolder;

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            int port = 5184;
            string envPort = Environment.GetEnvironmentVariable("PORT");
            if (!string.IsNullOrEmpty(envPort)) int.TryParse(envPort, out port);
            if (port <= 0) port = 5184;

            string exeDir = Path.GetDirectoryName(typeof(Program).Assembly.Location);
            string appData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TrendScope");
            userDataFolder = Path.Combine(appData, "webview2");
            try { Directory.CreateDirectory(userDataFolder); } catch { }

            string root = FindProjectRoot(exeDir);
            bool alreadyRunning = Alive(port);

            if (!alreadyRunning)
            {
                if (root == null)
                {
                    MessageBox.Show(
                        "找不到项目目录(需要 package.json 与 dist-server/index.js)。\n" +
                        "请把 TrendScope.exe 放在项目里运行,或者先在项目目录执行 npm start。",
                        "TrendScope 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                try { node = StartNode(root, port); }
                catch (Exception e)
                {
                    MessageBox.Show("启动本机服务失败:" + e.Message + "\n\n也可以先在项目目录执行 npm start,再打开本程序。",
                        "TrendScope 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                int tries = 0;
                while (!Alive(port) && tries < 100) { Thread.Sleep(300); tries++; }
                if (!Alive(port))
                {
                    MessageBox.Show(
                        "本机服务在 30 秒内没有就绪。\n" +
                        "常见原因是端口已被另一个实例占用 —— 换一个端口再试:先执行 set PORT=5199 再打开本程序。",
                        "TrendScope 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    if (node != null) { try { node.Kill(); } catch { } }
                    return;
                }
            }

            string iconPath = null;
            try
            {
                string ico = Path.Combine(exeDir, "TrendScope.ico");
                if (File.Exists(ico)) iconPath = ico;
            }
            catch { }

            using (ChromeForm form = new ChromeForm("TrendScope 趋势工作台", iconPath))
            {
                form.Size = new Size(1440, 900);
                form.MinimumSize = new Size(900, 600);
                form.StartPosition = FormStartPosition.CenterScreen;

                WebView2 view = new WebView2();
                view.Dock = DockStyle.Fill;
                form.ContentPanel.Controls.Add(view);
                string url = "http://localhost:" + port.ToString();

                form.Load += async delegate
                {
                    try
                    {
                        var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
                        await view.EnsureCoreWebView2Async(env);
                        view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                        view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                        view.CoreWebView2.NewWindowRequested += OnNewWindow;
                        view.CoreWebView2.Navigate(url);
                    }
                    catch (Exception e)
                    {
                        MessageBox.Show(
                            "内嵌浏览器初始化失败:" + e.Message +
                            "\n\n请确认已安装 WebView2 Runtime(Windows 10/11 通常自带)。" +
                            "\n也可以直接打开 " + url,
                            "TrendScope", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                };

                form.FormClosing += delegate { StopServer(); };
                Application.Run(form);
            }
            StopServer();
        }

        // 应用里点开的链接(比如热榜话题)交给系统浏览器,不在桌面壳里开新窗口
        static void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            var deferral = e.GetDeferral();
            try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
            deferral.Complete();
            e.Handled = true;
        }

        static void StopServer()
        {
            if (node == null) return;
            try { if (!node.HasExited) node.Kill(); } catch { }
            try { node.Dispose(); } catch { }
            node = null;
        }

        static Process StartNode(string root, int port)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "dist-server/index.js",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.EnvironmentVariables["PORT"] = port.ToString();
            return Process.Start(psi);
        }

        static string FindProjectRoot(string start)
        {
            var dir = new DirectoryInfo(start);
            for (int i = 0; i < 8 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, "package.json")) &&
                    File.Exists(Path.Combine(dir.FullName, "dist-server", "index.js")))
                    return dir.FullName;
                dir = dir.Parent;
            }
            return null;
        }

        static bool Alive(int port)
        {
            try
            {
                using (var c = new TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", port, null, null);
                    return ar.AsyncWaitHandle.WaitOne(400) && c.Connected;
                }
            }
            catch { return false; }
        }
    }

    // 无边框窗口 + 自绘标题栏:三键内嵌、拖拽区返回 HTCAPTION(原生拖拽/贴靠/双击最大化)、
    // 边缘命中返回 HTLEFT..HTBOTTOMRIGHT(保留系统级缩放)。
    sealed class ChromeForm : Form
    {
        const int HTCLIENT = 1;
        const int HTCAPTION = 2;
        const int HTLEFT = 10;
        const int HTRIGHT = 11;
        const int HTTOP = 12;
        const int HTTOPLEFT = 13;
        const int HTTOPRIGHT = 14;
        const int HTBOTTOM = 15;
        const int HTBOTTOMLEFT = 16;
        const int HTBOTTOMRIGHT = 17;
        const int WM_NCHITTEST = 0x84;
        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        const int DWMWCP_ROUND = 2;

        readonly Panel titleBar;
        readonly Panel content;
        readonly Button maxButton;

        public ChromeForm(string title, string iconPath)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9F);

            titleBar = new Panel();
            titleBar.Dock = DockStyle.Top;
            titleBar.Height = 36;
            titleBar.BackColor = Color.White;

            PictureBox pic = new PictureBox();
            pic.Size = new Size(18, 18);
            pic.Location = new Point(10, 9);
            pic.SizeMode = PictureBoxSizeMode.Zoom;
            try { if (iconPath != null) pic.Image = new Icon(iconPath, 18, 18).ToBitmap(); } catch { }
            titleBar.Controls.Add(pic);

            Label label = new Label();
            label.Text = title;
            label.AutoSize = false;
            label.Size = new Size(320, 36);
            label.Location = new Point(34, 0);
            label.TextAlign = ContentAlignment.MiddleLeft;
            label.ForeColor = Color.FromArgb(23, 32, 51);
            titleBar.Controls.Add(label);

            Button closeButton = CaptionButton("\uE8BB", Color.FromArgb(207, 63, 79), Color.White);
            closeButton.Click += delegate { Close(); };
            maxButton = CaptionButton("\uE922", Color.FromArgb(237, 241, 247), Color.FromArgb(23, 32, 51));
            maxButton.Click += delegate { ToggleMaximize(); };
            Button minButton = CaptionButton("\uE921", Color.FromArgb(237, 241, 247), Color.FromArgb(23, 32, 51));
            minButton.Click += delegate { WindowState = FormWindowState.Minimized; };
            titleBar.Controls.Add(closeButton);
            titleBar.Controls.Add(maxButton);
            titleBar.Controls.Add(minButton);

            titleBar.Resize += delegate
            {
                closeButton.Left = titleBar.Width - 46;
                maxButton.Left = closeButton.Left - 46;
                minButton.Left = maxButton.Left - 46;
                label.Width = Math.Max(80, minButton.Left - label.Left - 8);
            };

            content = new Panel();
            content.Dock = DockStyle.Fill;
            content.BackColor = Color.White;

            Controls.Add(content);
            Controls.Add(titleBar);

            try
            {
                int round = DWMWCP_ROUND;
                DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, 4);
            }
            catch { }
        }

        public Panel ContentPanel { get { return content; } }

        static Button CaptionButton(string glyph, Color hoverBack, Color hoverFore)
        {
            Button b = new Button();
            b.Text = glyph;
            b.Font = new Font("Segoe MDL2 Assets", 9F);
            b.Size = new Size(46, 36);
            b.Dock = DockStyle.None;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = hoverBack;
            b.ForeColor = Color.FromArgb(104, 117, 140);
            b.BackColor = Color.White;
            b.Tag = "caption-button";
            b.MouseEnter += delegate { b.ForeColor = hoverFore; };
            b.MouseLeave += delegate { b.ForeColor = Color.FromArgb(104, 117, 140); };
            return b;
        }

        void ToggleMaximize()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                WindowState = FormWindowState.Normal;
                maxButton.Text = "\uE922";
            }
            else
            {
                MaximizedBounds = Screen.FromControl(this).WorkingArea;
                WindowState = FormWindowState.Maximized;
                maxButton.Text = "\uE923";
            }
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            try { MaximizedBounds = Screen.FromControl(this).WorkingArea; } catch { }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
            {
                int lx = (short)((long)m.LParam & 0xFFFF);
                int ly = (short)(((long)m.LParam >> 16) & 0xFFFF);
                Point p = PointToClient(new Point(lx, ly));
                int edge = 6;
                bool left = p.X <= edge;
                bool right = p.X >= ClientSize.Width - edge;
                bool top = p.Y <= edge;
                bool bottom = p.Y >= ClientSize.Height - edge;
                if (top && left) { m.Result = (IntPtr)HTTOPLEFT; return; }
                if (top && right) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                if (bottom && left) { m.Result = (IntPtr)HTBOTTOMLEFT; return; }
                if (bottom && right) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                if (left) { m.Result = (IntPtr)HTLEFT; return; }
                if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                if (top) { m.Result = (IntPtr)HTTOP; return; }
                if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
                if (p.Y <= titleBar.Height && p.Y > edge)
                {
                    m.Result = (IntPtr)HTCAPTION;
                    return;
                }
            }
            base.WndProc(ref m);
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    }
}
