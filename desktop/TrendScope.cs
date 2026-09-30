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
// 注意:源码里有中文,编译必须带 /codepage:65001,否则 csc 会按本机 ANSI 码页读,
// 窗口标题和提示语会变成乱码。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
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

            using (var form = new Form())
            {
                form.Text = "TrendScope 趋势工作台";
                form.Size = new Size(1440, 900);
                form.MinimumSize = new Size(900, 600);
                form.StartPosition = FormStartPosition.CenterScreen;
                try
                {
                    string ico = Path.Combine(exeDir, "TrendScope.ico");
                    if (File.Exists(ico)) form.Icon = new Icon(ico);
                }
                catch { }

                var view = new WebView2 { Dock = DockStyle.Fill };
                form.Controls.Add(view);
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
}
