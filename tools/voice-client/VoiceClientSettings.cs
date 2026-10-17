/*
 * 语音采集客户端：本机设置与开机启动。
 *
 * 这里只存"这台机器上怎么采"——用哪块录音设备、要不要常驻托盘、要不要开机启动、
 * 医生端地址、监听端口。**不存**音频、病历、ASR 地址与密钥：那些不属于本机客户端。
 *
 * 为什么单独一份配置而不是全走命令行：托盘里的"配置录音设备"要能改完就记住，
 * 让医生/工程师每次都去改快捷方式属性，等于没有这个功能。
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Microsoft.Win32;

namespace VoiceCaptureClient
{
    internal sealed class ClientConfig
    {
        public const string AppDirName = "EmrVoiceClient";
        /** 开机启动写进 HKCU\...\Run 的值名（固定一个，重复勾选只覆盖自己） */
        public const string RunValueName = "EmrVoiceCaptureClient";

        /** 指定设备（编号或名字片段）；空 = 系统默认 */
        public string Device = "";
        /** 启动后常驻右下角托盘（隐藏控制台窗口） */
        public bool Tray;
        public bool AutoStart;
        public string PageUrl = "";
        public int Port = 8901;

        /** 配置文件路径：默认 %LOCALAPPDATA%\EmrVoiceClient\client.json，可用 `--config-file` 覆盖 */
        public static string DefaultPath
        {
            get
            {
                string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (root == null || root.Trim().Length == 0)
                {
                    /* 极少数服务账号下拿不到 LocalAppData：退到 exe 同目录，至少还能用 */
                    root = AppDomain.CurrentDomain.BaseDirectory;
                }
                return Path.Combine(Path.Combine(root, AppDirName), "client.json");
            }
        }

        public static ClientConfig Load(string path)
        {
            ClientConfig config = new ClientConfig();
            string file = path == null || path.Trim().Length == 0 ? DefaultPath : path;
            try
            {
                if (!File.Exists(file)) return config;
                object parsed = Json.Parse(File.ReadAllText(file, Encoding.UTF8));
                Dictionary<string, object> map = parsed as Dictionary<string, object>;
                if (map == null) return config;
                config.Device = Text(map, "device", "");
                config.Tray = Bool(map, "tray", false);
                config.AutoStart = Bool(map, "autostart", false);
                config.PageUrl = Text(map, "pageUrl", "");
                int port = (int)Number(map, "port", 8901);
                if (port > 0 && port <= 65535) config.Port = port;
            }
            catch
            {
                /* 配置坏了不该让客户端起不来：按默认走，用户重选一次设备就修好了 */
            }
            return config;
        }

        public void Save(string path)
        {
            string file = path == null || path.Trim().Length == 0 ? DefaultPath : path;
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["device"] = Device;
            map["tray"] = Tray;
            map["autostart"] = AutoStart;
            map["pageUrl"] = PageUrl;
            map["port"] = Port;

            string dir = Path.GetDirectoryName(file);
            if (dir != null && dir.Length > 0) Directory.CreateDirectory(dir);
            /* 先写临时文件再替换：断电/崩溃不至于留下半个 JSON（那会让下次启动读不出设备） */
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, Json.Serialize(map), new UTF8Encoding(false));
            if (File.Exists(file)) File.Delete(file);
            File.Move(tmp, file);
        }

        public static string ToJson(ClientConfig config, string path)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["ok"] = true;
            map["path"] = path == null || path.Trim().Length == 0 ? DefaultPath : path;
            map["device"] = config.Device;
            map["tray"] = config.Tray;
            map["autostart"] = config.AutoStart;
            map["pageUrl"] = config.PageUrl;
            map["port"] = config.Port;
            return Json.Serialize(map);
        }

        private static string Text(Dictionary<string, object> map, string key, string fallback)
        {
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return fallback;
            string text = value as string;
            return text == null ? fallback : text;
        }

        private static bool Bool(Dictionary<string, object> map, string key, bool fallback)
        {
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return fallback;
            return value is bool ? (bool)value : fallback;
        }

        private static double Number(Dictionary<string, object> map, string key, double fallback)
        {
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return fallback;
            return value is double ? (double)value : fallback;
        }
    }

    /** 托盘模式下控制台是隐藏的：输出必须落到文件，否则现场出问题无从查起 */
    internal static class ClientLog
    {
        private const long MaxBytes = 2L * 1024 * 1024;

        public static string FilePath
        {
            get
            {
                string dir = Path.GetDirectoryName(ClientConfig.DefaultPath);
                return Path.Combine(dir == null ? "." : dir, "client.log");
            }
        }

        public static void Redirect()
        {
            string file = FilePath;
            string dir = Path.GetDirectoryName(file);
            if (dir != null && dir.Length > 0) Directory.CreateDirectory(dir);
            try
            {
                /* 超过 2MB 就重开一份：常驻进程的日志不能无限长下去 */
                if (File.Exists(file) && new FileInfo(file).Length > MaxBytes) File.Delete(file);
            }
            catch
            {
                /* 删不掉就接着写，总比没有日志好 */
            }
            StreamWriter writer = new StreamWriter(file, true, new UTF8Encoding(false));
            writer.AutoFlush = true;
            Console.SetOut(writer);
            Console.SetError(writer);
        }
    }

    /**
     * 开机启动：只写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run。
     *
     * 为什么是 HKCU 而不是"启动"文件夹：同一个注册表值名重复写入只留一条，
     * 取消时也只需删自己那一条；不需要管理员权限，也不会影响这台机器的其他账号。
     *
     * 代价要说清：它按**用户**生效 —— 换人登录不会自动启动，这正是不把设备选择
     * 与开机启动塞进 HKLM 的原因（多用户共用的工作站上，别人的麦克风不该替我打开）。
     */
    internal static class AutoStart
    {
        private const string RunPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static string CommandLine(string exePath, int port)
        {
            /* --tray：启动后隐藏控制台、常驻托盘 —— 开机自启不该在屏幕上弹一个黑框 */
            return "\"" + exePath + "\" --tray --port " + port.ToString(CultureInfo.InvariantCulture);
        }

        public static bool Enabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunPath, false))
                {
                    if (key == null) return false;
                    object value = key.GetValue(ClientConfig.RunValueName);
                    return value != null && value.ToString().Trim().Length > 0;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool Set(bool on, string exePath, int port)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunPath))
                {
                    if (key == null) return false;
                    if (on) key.SetValue(ClientConfig.RunValueName, CommandLine(exePath, port), RegistryValueKind.String);
                    else key.DeleteValue(ClientConfig.RunValueName, false);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        public static string StatusJson(int port)
        {
            string exe = Path.GetFullPath(Environment.GetCommandLineArgs()[0]);
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"enabled\":").Append(Enabled() ? "true" : "false");
            sb.Append(",\"runKey\":").Append(Json.Quote(@"HKCU\" + RunPath + "\\" + ClientConfig.RunValueName));
            sb.Append(",\"command\":").Append(Json.Quote(CommandLine(exe, port)));
            sb.Append('}');
            return sb.ToString();
        }
    }
}
