/*
 * 语音采集客户端：右下角托盘常驻 + 录音设备配置窗口。
 *
 * 为什么要有它：多块采集卡的终端上，"这次到底用哪块卡"必须能在机器上直接改、改完就记住。
 * 让医生去改快捷方式属性或记命令行参数，等于没有这个功能。
 *
 * 三条纪律：
 *   1. 托盘只是**外壳**：采集、分片、桥协议一行不动，音频路径不受影响；
 *   2. 换设备**不在采集中生效**（那会把当前这一段打断），窗口里明说"下一次开始采集生效"；
 *   3. 设备找不到时**不回落系统默认**，托盘图标变红、窗口里指出哪一块不见了。
 *
 * 只在 --tray 模式下加载（普通控制台模式不碰任何窗口代码）。
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace VoiceCaptureClient
{
    internal static class TrayApp
    {
        private const int SwHide = 0;

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        /** 托盘里能改的东西都在这里：采集运行时、配置、以及"怎么退出" */
        internal sealed class TrayOptions
        {
            public Runtime Runtime;
            public ClientConfig Config;
            public string ConfigPath = "";
            public string PageUrl = "";
            public int Port = 8901;
            public ManualResetEvent Stop;
        }

        public static void Run(TrayOptions options)
        {
            HideConsole();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            NotifyIcon icon = new NotifyIcon();
            icon.Icon = LoadIcon();
            icon.Text = Short("语音采集客户端");
            icon.Visible = true;

            /* Windows 默认把**新**托盘图标折叠进溢出区（用户第一眼看不到，会以为没启动）。
               启动时弹一次说明：既把它临时顶到可见区，也告诉人这个图标能干什么。
               延迟一下再弹：通知区还没把图标登记好时 ShowBalloonTip 会被静默丢掉。 */
            System.Windows.Forms.Timer greet = new System.Windows.Forms.Timer();
            greet.Interval = 1500;
            greet.Tick += delegate(object sender, EventArgs e)
            {
                greet.Stop();
                greet.Dispose();
                Notify(icon, "语音采集客户端已常驻",
                    "点这个图标可以配置用哪一块录音设备；退出请用右键菜单。",
                    ToolTipIcon.Info);
            };
            greet.Start();

            ToolStripMenuItem status = new ToolStripMenuItem("正在启动…");
            status.Enabled = false;
            ToolStripMenuItem settingsItem = new ToolStripMenuItem("配置录音设备…");
            ToolStripMenuItem openItem = new ToolStripMenuItem("打开医生端");
            ToolStripMenuItem autoItem = new ToolStripMenuItem("开机启动（登录后自动运行）");
            autoItem.CheckOnClick = true;
            autoItem.Checked = AutoStart.Enabled();
            ToolStripMenuItem quitItem = new ToolStripMenuItem("退出");

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(status);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(settingsItem);
            menu.Items.Add(openItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(autoItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quitItem);
            icon.ContextMenuStrip = menu;

            DeviceForm form = new DeviceForm(options, null);
            Action showSettings = delegate
            {
                if (form.IsDisposed) form = new DeviceForm(options, null);
                /* 已经开着就把它拉到前面，**不再开第二个**：两个窗口各改各的设备，
                   最后谁生效取决于谁后点保存，现场只会得到"改了没用"的结论。 */
                if (form.Visible)
                {
                    if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
                    form.Activate();
                    form.BringToFront();
                    return;
                }
                if (SettingsWindowExists())
                {
                    /* 另一个进程开着了：把**那个**窗口拉到前面。
                       只弹一句"已经打开了"等于让人自己去找，找不到就以为没反应。 */
                    FocusExistingSettings();
                    return;
                }
                /* 每次打开都重新枚举：设备可能刚插上/刚拔掉 */
                form.ReloadDevices();
                form.Show();
                form.Activate();
                form.BringToFront();
            };

            /* 左键单击/双击都打开配置：用户说的"点一下就能配"，不该还得先找右键菜单 */
            icon.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) showSettings();
            };
            icon.DoubleClick += delegate { showSettings(); };
            settingsItem.Click += delegate { showSettings(); };

            openItem.Click += delegate
            {
                string target = options.PageUrl.Trim().Length > 0
                    ? options.PageUrl
                    : "http://127.0.0.1:8787/";
                try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
                catch (Exception ex) { Notify(icon, "打不开医生端", ex.Message, ToolTipIcon.Warning); }
            };
            autoItem.Click += delegate
            {
                bool want = autoItem.Checked;
                string exe = Application.ExecutablePath;
                if (!AutoStart.Set(want, exe, options.Port))
                {
                    autoItem.Checked = !want;
                    Notify(icon, "改不了开机启动", "写 HKCU\\...\\Run 失败：可能是安全软件拦了注册表写入", ToolTipIcon.Warning);
                    return;
                }
                options.Config.AutoStart = want;
                options.Config.Save(options.ConfigPath);
                Notify(icon, want ? "已设为开机启动" : "已取消开机启动",
                    want ? "下次登录 Windows 会用当前设备配置自动运行（不会弹黑框）" : "下次登录不会再自动运行", ToolTipIcon.Info);
            };
            quitItem.Click += delegate
            {
                icon.Visible = false;
                options.Stop.Set();
                Application.Exit();
            };

            /* 状态每秒刷新一次：采集中/空闲/采集源异常，托盘上要能一眼看出 */
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 1000;
            timer.Tick += delegate(object sender, EventArgs e)
            {
                /* 外部让停（Ctrl+C / 另一个实例要求退出）：UI 线程里退出，不能从后台线程调 Application.Exit */
                if (options.Stop.WaitOne(0))
                {
                    timer.Stop();
                    icon.Visible = false;
                    Application.Exit();
                    return;
                }
                Dictionary<string, object> problem = options.Runtime.Problem;
                if (problem != null)
                {
                    icon.Icon = SystemIcons.Error;
                    status.Text = Short("采集源异常：" + Text(problem, "message"));
                    icon.Text = Short("语音采集客户端 · 采集源异常");
                }
                else
                {
                    icon.Icon = LoadIcon();
                    status.Text = Short(StatusText(options.Runtime, options.Port));
                    icon.Text = Short("语音采集客户端 · " + StatusText(options.Runtime, options.Port));
                }
            };
            timer.Start();

            Application.ApplicationExit += delegate
            {
                timer.Stop();
                icon.Visible = false;
                icon.Dispose();
            };

            Application.Run();
        }

        /* ---------------- "配置录音设备"窗口：整个会话只允许一个 ----------------
           判断依据是**窗口本身是否已经存在**，不是互斥量：
           托盘与 `--settings` 是两个进程，用窗口探测天然跨进程，也不会出现
           "上一个进程崩了、锁没释放、此后永远打不开"这类锁状态问题。 */

        private const string SettingsTitle = "配置录音设备";

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private static bool SettingsWindowExists()
        {
            try { return FindWindow(null, SettingsTitle) != IntPtr.Zero; }
            catch { return false; }
        }

        /**
         * 把**已经开着**的「配置录音设备」窗口切到前台。
         *
         * 为什么不是弹一句"已经打开了"：那句话等于让人自己去找窗口；
         * 找不到就会以为按钮坏了，然后再点几次。把窗口顶到前面是唯一不产生歧义的回答。
         */
        private static void FocusExistingSettings()
        {
            try
            {
                IntPtr handle = FindWindow(null, SettingsTitle);
                if (handle == IntPtr.Zero) return;
                ShowWindow(handle, 9); /* SW_RESTORE：最小化过也要能还原 */
                SetForegroundWindow(handle);
            }
            catch
            {
                /* 前台切换可能被系统策略拒绝，不算错误 */
            }
        }

        /** 只开一次配置窗口（`--settings`）：不建托盘、不碰采集 */
        public static void ShowSettingsOnly(TrayOptions options)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (SettingsWindowExists())
            {
                /* 已经有窗口了：把它切到前台，然后悄悄退出 ——
                   这比再开一个（各改各的）更符合"只允许一个"的意思。 */
                FocusExistingSettings();
                return;
            }
            DeviceForm form = new DeviceForm(options, null);
            form.ReloadDevices();
            form.ShowDialog();
        }

        private static string StatusText(Runtime runtime, int port)
        {
            Bridge bridge = runtime.Bridge;
            if (bridge != null)
            {
                Dictionary<string, object> progress = bridge.Progress();
                string state = Text(progress, "state");
                if (state == "recording")
                {
                    double elapsed = 0;
                    object value;
                    if (progress.TryGetValue("elapsedSec", out value) && value is double) elapsed = (double)value;
                    return "采集中 · 已录 " + elapsed.ToString("0.0") + "s";
                }
                if (state == "done") return "空闲（上一次采集已结束）";
            }
            return "空闲 · 监听 127.0.0.1:" + port;
        }

        private static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value) || value == null) return "";
            string text = value as string;
            return text == null ? "" : text;
        }

        private static void HideConsole()
        {
            IntPtr handle = GetConsoleWindow();
            if (handle != IntPtr.Zero) ShowWindow(handle, SwHide);
        }

        private static Icon LoadIcon()
        {
            try
            {
                Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (icon != null) return icon;
            }
            catch { /* 没有图标资源也能跑，用系统图标顶上 */ }
            return SystemIcons.Application;
        }

        /** NotifyIcon.Text 上限 63 字符，超了会直接抛异常（那会让托盘整个消失） */
        private static string Short(string text)
        {
            if (text == null) return "";
            return text.Length <= 63 ? text : text.Substring(0, 60) + "…";
        }

        private static void Notify(NotifyIcon icon, string title, string text, ToolTipIcon kind)
        {
            try { icon.ShowBalloonTip(4000, title, text, kind); }
            catch { /* 气泡被系统策略禁掉不影响功能 */ }
        }
    }

    /**
     * 录音设备配置窗口。
     *
     * 只做三件事：列出设备、选一块、保存到本机配置。
     * 采集中不改当前这一次（会把这一段打断），窗口里明确写"下一次开始采集生效"。
     */
    internal sealed class DeviceForm : Form
    {
        private readonly TrayApp.TrayOptions options;
        private readonly ComboBox combo = new ComboBox();
        private readonly Label current = new Label();
        private readonly Label notice = new Label();
        private List<AudioDevice> devices = new List<AudioDevice>();

        public DeviceForm(TrayApp.TrayOptions options, IWin32Window owner)
        {
            this.options = options;
            Text = "配置录音设备";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            ClientSize = new Size(560, 320);
            Font = SystemFonts.MessageBoxFont;

            Label intro = new Label();
            intro.SetBounds(16, 12, 528, 48);
            intro.Text = "选这台机器录音时用哪一块设备。多块采集卡时**必须**指定："
                + "系统默认设备会被别的程序、插拔或驱动更新换掉，而界面上看不出来。";
            Controls.Add(intro);

            combo.SetBounds(16, 66, 528, 26);
            combo.DropDownStyle = ComboBoxStyle.DropDownList;
            Controls.Add(combo);

            Button refresh = new Button();
            refresh.Text = "刷新";
            refresh.SetBounds(16, 104, 80, 28);
            refresh.Click += delegate { ReloadDevices(); };
            Controls.Add(refresh);

            Button save = new Button();
            save.Text = "保存";
            save.SetBounds(374, 104, 80, 28);
            save.Click += delegate { SaveAndClose(); };
            Controls.Add(save);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.SetBounds(464, 104, 80, 28);
            cancel.Click += delegate { Close(); };
            Controls.Add(cancel);

            current.SetBounds(16, 146, 528, 60);
            current.ForeColor = SystemColors.GrayText;
            Controls.Add(current);

            notice.SetBounds(16, 210, 528, 90);
            notice.ForeColor = SystemColors.GrayText;
            notice.Text = "换设备不会打断正在进行的采集：保存后从**下一次**点「开始采集」起生效。";
            Controls.Add(notice);

            ReloadDevices();
        }

        /** 重新枚举（只读：不打开设备、不占麦克风） */
        public void ReloadDevices()
        {
            devices = AudioDevices.List();
            combo.Items.Clear();
            combo.Items.Add(new DeviceItem("", "系统默认（不推荐：会随其他程序/插拔变化）"));
            foreach (AudioDevice device in devices)
            {
                /* 存**名字**而不是编号：插拔之后编号会重排，名字不会 —— 存编号会在第二天
                   悄悄打开另一块卡，而且页面上一切正常。 */
                combo.Items.Add(new DeviceItem(
                    device.Name,
                    "#" + device.Index + " " + device.Name + (device.Channels > 0 ? "（" + device.Channels + " 通道）" : "")));
            }

            string configured = options.Config.Device == null ? "" : options.Config.Device.Trim();
            int selected = 0;
            if (configured.Length > 0)
            {
                for (int i = 0; i < combo.Items.Count; i += 1)
                {
                    DeviceItem item = (DeviceItem)combo.Items[i];
                    if (item.Spec.Length > 0 && Matches(configured, item)) { selected = i; break; }
                }
            }
            combo.SelectedIndex = selected;

            current.Text = devices.Count == 0
                ? "本机当前没有可用的录音设备：确认采集卡已插好、驱动已装，再点「刷新」。"
                : "本机共 " + devices.Count + " 块录音设备；当前选择："
                  + (configured.Length == 0 ? "系统默认" : configured);
            if (configured.Length > 0 && selected == 0)
            {
                current.Text += "（配置的那块没找到：保存前请重选，否则采集会报错而不会偷偷改用默认设备）";
                current.ForeColor = Color.Firebrick;
            }
            else
            {
                current.ForeColor = SystemColors.GrayText;
            }
        }

        private static bool Matches(string configured, DeviceItem item)
        {
            /* 配置里存的是名字片段或编号；两种都要认，否则"#2 XX 卡"会被当成名字匹配不上 */
            if (item.Spec.IndexOf(configured, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (item.Label.IndexOf(configured, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private void SaveAndClose()
        {
            DeviceItem item = combo.SelectedItem as DeviceItem;
            string spec = item == null ? "" : item.Spec;
            options.Config.Device = spec;
            try
            {
                options.Config.Save(options.ConfigPath);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "保存失败：" + ex.Message + "\n\n配置没写成，采集仍按原来的选择走。",
                    "配置录音设备", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            /* 立刻把新选择告诉运行时：下一次 /start 就用它（采集中不改，返回 false）。
               设备刚好在这一下被拔掉时，Resolve 会失败 —— 保存了配置但采集会明确报错，
               而不是偷偷换一块。 */
            bool applied = true;
            try
            {
                /* `--settings` 单独开窗口时没有运行时：只写配置，下次启动生效 */
                if (options.Runtime != null) applied = options.Runtime.SetDeviceFromSpec(spec);
            }
            catch (DeviceSelectionException ex)
            {
                MessageBox.Show(this, "已保存选择，但这块设备现在找不到：" + ex.Message + "\n\n" + ex.HowTo,
                    "配置录音设备", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
                return;
            }
            Close();
            if (!applied)
            {
                MessageBox.Show(
                    "已保存。当前正在采集，所以这一次仍用原来的设备；下一次点「开始采集」起生效。",
                    "配置录音设备", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private sealed class DeviceItem
        {
            public readonly string Spec;
            public readonly string Label;

            public DeviceItem(string spec, string label)
            {
                Spec = spec == null ? "" : spec;
                Label = label == null ? "" : label;
            }

            public override string ToString() { return Label; }
        }
    }
}
