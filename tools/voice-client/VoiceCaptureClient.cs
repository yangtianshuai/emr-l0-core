/*
 * 语音采集客户端（Windows 单文件 exe，C# 5 / .NET Framework 4.x）
 *
 * 它做什么：从**本机麦克风**采 16 kHz / 单声道 / 16-bit PCM → 静音判停分片（S1~S4）
 * → 在 127.0.0.1 上把段交给页面（页面再上传同源采集路由，由服务端转发 ASR）。
 *
 * 为什么是独立 exe：页面在 http://10.x 下拿不到麦克风（安全上下文），而本机进程没有这个限制。
 * 只绑 127.0.0.1 + 一次性令牌：回环端口不是安全边界，令牌才是。
 *
 * ★ 与 src/dictation/capture.ts 的关系：分片规则、WAV 头、桥的 ack 语义都是**第二份实现**。
 *   这是有意的代价（Node 没有麦克风 API），用 `--selftest-segments` 与
 *   src/dictation/voice-client-self-test.ts 逐字段对拍，防止两份规则分叉。
 *
 * 构建：tools/voice-client/build.ps1（调用系统自带 csc.exe，离线、无第三方依赖）
 * 用法：VoiceCaptureClient.exe [--port 8901] [--token xxx] [--page http://127.0.0.1:8787/]
 *                               [--source mic|tone] [--open] [--help]
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace VoiceCaptureClient
{
    internal static class Program
    {
        /**
         * [STAThread] 不是可选项：WinForms 的窗口与剪贴板都要求 STA，
         * 缺了它托盘图标还能出现（NotifyIcon 不碰 OLE），但"配置录音设备"窗口会起不来。
         */
        [STAThread]
        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; }
            catch { /* 某些宿主不允许改编码：输出乱码也不能因此不启动 */ }

            Options options = Options.Parse(args);
            if (options.Help)
            {
                Options.PrintHelp();
                return 0;
            }

            ClientConfig config = ClientConfig.Load(options.ConfigPath);

            if (options.PrintConfig)
            {
                Console.WriteLine(ClientConfig.ToJson(config, options.ConfigPath));
                return 0;
            }
            if (options.AutoStartMode.Length > 0)
            {
                if (options.AutoStartMode == "status")
                {
                    Console.WriteLine(AutoStart.StatusJson(options.Port));
                    return 0;
                }
                bool enable;
                if (options.AutoStartMode == "on") enable = true;
                else if (options.AutoStartMode == "off") enable = false;
                else
                {
                    Console.Error.WriteLine("--autostart 只支持 on / off / status");
                    return 2;
                }
                string exePath = Path.GetFullPath(Environment.GetCommandLineArgs()[0]);
                if (!AutoStart.Set(enable, exePath, options.Port))
                {
                    Console.Error.WriteLine("改不了开机启动：写 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 失败（可能被安全软件拦了）");
                    return 2;
                }
                config.AutoStart = enable;
                config.Port = options.Port;
                try { config.Save(options.ConfigPath); } catch { /* 注册表已改，配置写不进去不该报失败 */ }
                Console.WriteLine(AutoStart.StatusJson(options.Port));
                return 0;
            }
            if (options.SetDeviceSpecified)
            {
                string spec = options.SetDevice.Trim();
                if (spec.Length == 0 || string.Equals(spec, "default", StringComparison.OrdinalIgnoreCase))
                {
                    config.Device = "";
                }
                else
                {
                    try
                    {
                        /* 先解析再落盘：把"不存在的设备"写进配置，下次启动才发现，等于埋一个雷 */
                        AudioDevice chosen = AudioDevices.Resolve(spec);
                        config.Device = chosen.Name;
                    }
                    catch (DeviceSelectionException ex)
                    {
                        Console.Error.WriteLine("选设备失败：" + ex.Message);
                        Console.Error.WriteLine("怎么办：" + ex.HowTo);
                        return 2;
                    }
                }
                try { config.Save(options.ConfigPath); }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("写配置失败：" + ex.Message);
                    return 2;
                }
                Console.WriteLine(ClientConfig.ToJson(config, options.ConfigPath));
                return 0;
            }
            if (options.Settings)
            {
                /* 只开窗口：不监听端口、不打开设备、不采集。
                   存在的理由：Win11 会把新托盘图标折叠进溢出区，现场"找不到图标"时
                   这条命令行是唯一能直接到配置窗口的路。 */
                TrayApp.TrayOptions settingsOptions = new TrayApp.TrayOptions();
                settingsOptions.Runtime = null;
                settingsOptions.Config = config;
                settingsOptions.ConfigPath = options.ConfigPath;
                settingsOptions.PageUrl = options.PageUrl;
                settingsOptions.Port = options.Port;
                TrayApp.ShowSettingsOnly(settingsOptions);
                return 0;
            }
            if (options.ListDevices)
            {
                /* 只读：枚举设备、输出 JSON、退出 —— 不监听端口、不打开设备 */
                Console.WriteLine(AudioDevices.ToJson(AudioDevices.List()));
                return 0;
            }
            if (options.SelfTestSegments)
            {
                Console.WriteLine(SelfTest.RunSegments(options.TimelineSpec, options.SegmentSpec));
                return 0;
            }
            if (options.SelfTestStall)
            {
                Console.WriteLine(SelfTest.RunStall(options.StallMs));
                return 0;
            }

            /* 托盘模式：隐藏控制台（开机自启不该弹黑框），输出改到日志文件 —— 出问题要能查 */
            bool tray = options.TraySpecified ? options.Tray : config.Tray;
            if (tray)
            {
                try { ClientLog.Redirect(); } catch { /* 日志写不了也要能采音 */ }
            }

            /* 设备优先级：`--device`（显式）> 配置文件 > 系统默认。
               - 显式指定却找不到 → 退出 2（脚本/运维要立刻失败）；
               - 配置里存的那块找不到 → 不退出，但**也不回落默认**：启动即带 sourceProblem，
                 页面与托盘都能看到"选的那块不在了"，人可以在托盘里重选。 */
            int micDeviceId = AudioDevices.MapperId;
            string micDeviceName = "";
            Dictionary<string, object> startupProblem = null;
            string configuredDevice = config.Device == null ? "" : config.Device.Trim();
            string deviceSpec = options.DeviceSpecified ? options.Device.Trim() : configuredDevice;
            if (options.Source == "mic" && deviceSpec.Length > 0)
            {
                try
                {
                    AudioDevice chosen = AudioDevices.Resolve(deviceSpec);
                    micDeviceId = chosen.Index;
                    micDeviceName = chosen.Name;
                }
                catch (DeviceSelectionException ex)
                {
                    if (options.DeviceSpecified)
                    {
                        Console.Error.WriteLine("选设备失败：" + ex.Message);
                        Console.Error.WriteLine("怎么办：" + ex.HowTo);
                        return 2;
                    }
                    startupProblem = new Dictionary<string, object>();
                    startupProblem["code"] = ex.Code;
                    startupProblem["message"] = ex.Message;
                    startupProblem["howTo"] = ex.HowTo;
                    /* 名字留着：状态行要能说出"配置的是哪一块"，而不是含糊地当成系统默认 */
                    micDeviceName = deviceSpec;
                }
            }

            /* 同一端口只允许一个实例：开机自启 + 手动双击很容易撞上，
               第二个实例再监听会失败，人只会看到一个莫名其妙的报错。 */
            bool created;
            Mutex singleInstance = new Mutex(true, "Local\\EmrVoiceCaptureClient-" + options.Port, out created);
            if (!created)
            {
                Console.Error.WriteLine("已经在运行（端口 " + options.Port + "）：看右下角托盘图标，点开即可配置录音设备。");
                return 0;
            }

            /* 令牌可选：给了就校验；没给就是"本机演示"形态 —— 但回环端口仍按 Origin 白名单挡网页。
               为什么保留令牌：去掉它以后，任何网页都能指挥本机麦克风；生产必须打开。 */
            string token = options.Token;
            /* 医生端地址：命令行给了用命令行的，否则用配置里存的（托盘的"打开医生端"要用同一个） */
            string pageUrl = options.PageUrl.Trim().Length > 0 ? options.PageUrl.Trim() : config.PageUrl.Trim();
            List<string> allowedOrigins = BuildAllowedOrigins(pageUrl, options.AllowOrigins);

            Runtime runtime = new Runtime(options.Source, micDeviceId, micDeviceName, startupProblem);
            BridgeServer server;
            try
            {
                server = new BridgeServer(options.Port, token, pageUrl, allowedOrigins, runtime);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("启动失败：无法监听 127.0.0.1:" + options.Port + "（" + ex.Message + "）");
                Console.Error.WriteLine("怎么办：换一个端口（--port 8902），或先结束占用该端口的程序。");
                return 2;
            }

            Console.WriteLine("  语音采集客户端：只绑 127.0.0.1:" + options.Port + "（音频不出本机）");
            Console.WriteLine("  采集源：" + runtime.SourceLabel);
            if (startupProblem != null)
            {
                object problemText;
                startupProblem.TryGetValue("message", out problemText);
                Console.WriteLine("  ! 配置的录音设备没找到：" + (problemText == null ? "" : problemText.ToString()));
                Console.WriteLine("    " + AudioDevices.DescribeChoices(AudioDevices.List()));
                Console.WriteLine("    采集会拒绝开始（不会改用系统默认）；点托盘图标可重选。");
            }
            Console.WriteLine(tray
                ? "  运行方式：常驻托盘（点右下角图标配置录音设备；退出请用托盘菜单）"
                : "  运行方式：控制台（Ctrl+C 停止）");
            string page = ComposePageUrl(pageUrl, options.Port, token);
            Console.WriteLine(token.Length == 0 ? "  页面地址（未启用令牌；直接打开医生端即可）：" : "  页面地址（带着令牌，用它打开医生端）：");
            Console.WriteLine("    " + page);
            if (token.Length == 0)
            {
                Console.WriteLine("  ! 未启用令牌：只接受允许来源的网页请求（默认 " + string.Join(" / ", allowedOrigins.ToArray()) + "）");
                Console.WriteLine("  ! 生产环境请用 --token <随机串> 打开校验：没有令牌，本机回环端口对同机网页是可写的");
            }
            if (options.Source == "mic")
            {
                Console.WriteLine("  ! 首次采集时 Windows 可能要求「允许桌面应用访问麦克风」（设置 → 隐私 → 麦克风）");
                /* 多块卡却说不出"用的是哪块"，是这类现场最常见的坑：这里主动点出来 */
                if (deviceSpec.Length == 0)
                {
                    List<AudioDevice> devices = AudioDevices.List();
                    if (devices.Count > 1)
                    {
                        Console.WriteLine("  ! 本机有 " + devices.Count + " 块录音设备，当前用系统默认（会随其他程序/插拔变化）：");
                        Console.WriteLine("    " + AudioDevices.Names(devices));
                        Console.WriteLine("    建议点托盘图标选一块（或用 --device <编号|名字片段>）");
                    }
                }
            }

            if (options.OpenBrowser && pageUrl.Length > 0)
            {
                try { Process.Start(new ProcessStartInfo(page) { UseShellExecute = true }); }
                catch { /* 打不开浏览器不影响采集服务本身 */ }
            }

            ManualResetEvent stop = new ManualResetEvent(false);
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                stop.Set();
            };
            if (tray)
            {
                TrayApp.TrayOptions trayOptions = new TrayApp.TrayOptions();
                trayOptions.Runtime = runtime;
                trayOptions.Config = config;
                trayOptions.ConfigPath = options.ConfigPath;
                trayOptions.PageUrl = pageUrl;
                trayOptions.Port = options.Port;
                trayOptions.Stop = stop;
                try
                {
                    TrayApp.Run(trayOptions);
                }
                catch (Exception ex)
                {
                    /* 托盘起不来不能连采集一起废掉：退回控制台，至少还能采 */
                    Console.Error.WriteLine("托盘起不来（" + ex.Message + "）：退回控制台模式，Ctrl+C 停止");
                    stop.WaitOne();
                }
            }
            else
            {
                stop.WaitOne();
            }
            GC.KeepAlive(singleInstance);
            server.Dispose();
            runtime.Dispose();
            return 0;
        }

        private static string ComposePageUrl(string pageUrl, int port, string token)
        {
            string baseUrl = pageUrl.Length == 0 ? "http://<服务端地址>/" : pageUrl;
            char join = baseUrl.IndexOf('?') >= 0 ? '&' : '?';
            string url = baseUrl + join + "captureClient=" + Uri.EscapeDataString("127.0.0.1:" + port);
            if (token.Length > 0) url += "&captureToken=" + Uri.EscapeDataString(token);
            return url;
        }

        /** 允许来源 = `--page` 的 origin + 默认本机医生端 + `--allow-origin` 追加项。 */
        private static List<string> BuildAllowedOrigins(string pageUrl, string extra)
        {
            List<string> origins = new List<string>();
            AddOrigin(origins, "http://127.0.0.1:8787");
            AddOrigin(origins, "http://localhost:8787");
            if (pageUrl.Length > 0)
            {
                try
                {
                    Uri uri = new Uri(pageUrl);
                    AddOrigin(origins, uri.Scheme + "://" + uri.Authority);
                }
                catch { /* --page 不是合法 URL：只是拼地址用，这里不拦 */ }
            }
            if (extra.Length > 0)
            {
                foreach (string part in extra.Split(',')) AddOrigin(origins, part);
            }
            return origins;
        }

        private static void AddOrigin(List<string> origins, string value)
        {
            string normalized = value.Trim().TrimEnd('/').ToLowerInvariant();
            if (normalized.Length == 0 || origins.Contains(normalized)) return;
            origins.Add(normalized);
        }
    }

    /* ============================== 命令行 ============================== */

    internal sealed class Options
    {
        public int Port = 8901;
        public string Token = "";
        public string PageUrl = "";
        /** 额外的允许来源（逗号分隔）；默认已含 --page 的 origin 与本机医生端 */
        public string AllowOrigins = "";
        /** mic = 真麦克风；tone = 合成音频（自测 / 没有麦克风的机器） */
        public string Source = "mic";
        /**
         * 用哪一块录音设备：`<编号>` 或 `<名字片段>`。空 = 系统默认（WAVE_MAPPER）。
         *
         * 多块采集卡的终端上**必须能指定**：系统「默认输入设备」是单点，别的程序改一次、
         * 插拔一次就可能换掉，而采集端不会知道 —— 那会录到另一只麦克风，且界面上看不出来。
         */
        public string Device = "";
        /** 命令行是否显式给了 --device（决定"找不到设备"时是退出还是降级成 problem） */
        public bool DeviceSpecified;
        public bool ListDevices;
        /** 常驻右下角托盘（隐藏控制台）；不指定时用配置里的值 */
        public bool Tray;
        public bool TraySpecified;
        /** `--autostart on|off|status`：改开机启动后退出 */
        public string AutoStartMode = "";
        /** `--set-device <编号|名字片段|default>`：写进配置后退出（托盘之外的配置入口） */
        public string SetDevice = "";
        public bool SetDeviceSpecified;
        public bool PrintConfig;
        /** 只打开"配置录音设备"窗口后退出（托盘图标被系统折叠时，现场也有一个直达入口） */
        public bool Settings;
        /** 配置文件路径（默认 %LOCALAPPDATA%\EmrVoiceClient\client.json） */
        public string ConfigPath = "";
        public bool OpenBrowser;
        public bool Help;
        public bool SelfTestSegments;
        public bool SelfTestStall;
        /** 自测用：无帧看门狗的超时（毫秒），只影响 `--selftest-stall` */
        public int StallMs = 200;
        public string TimelineSpec = "";
        public string SegmentSpec = "";

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            for (int i = 0; i < args.Length; i += 1)
            {
                string arg = args[i];
                switch (arg)
                {
                    case "--port": options.Port = ParseInt(Next(args, ref i, "--port"), 8901); break;
                    case "--token": options.Token = Next(args, ref i, "--token"); break;
                    case "--page": options.PageUrl = Next(args, ref i, "--page"); break;
                    case "--allow-origin": options.AllowOrigins = Next(args, ref i, "--allow-origin"); break;
                    case "--source": options.Source = Next(args, ref i, "--source").ToLowerInvariant(); break;
                    case "--device": options.Device = Next(args, ref i, "--device"); options.DeviceSpecified = true; break;
                    case "--list-devices": options.ListDevices = true; break;
                    case "--tray": options.Tray = true; options.TraySpecified = true; break;
                    case "--no-tray": options.Tray = false; options.TraySpecified = true; break;
                    case "--autostart": options.AutoStartMode = Next(args, ref i, "--autostart").ToLowerInvariant(); break;
                    case "--set-device": options.SetDevice = Next(args, ref i, "--set-device"); options.SetDeviceSpecified = true; break;
                    case "--print-config": options.PrintConfig = true; break;
                    case "--settings": options.Settings = true; break;
                    case "--config-file": options.ConfigPath = Next(args, ref i, "--config-file"); break;
                    case "--open": options.OpenBrowser = true; break;
                    case "--help": case "-h": case "/?": options.Help = true; break;
                    case "--selftest-segments": options.SelfTestSegments = true; break;
                    case "--selftest-stall": options.SelfTestStall = true; break;
                    case "--stall-ms": options.StallMs = ParseInt(Next(args, ref i, "--stall-ms"), 200); break;
                    case "--timeline": options.TimelineSpec = Next(args, ref i, "--timeline"); break;
                    case "--config": options.SegmentSpec = Next(args, ref i, "--config"); break;
                    default:
                        Console.Error.WriteLine("不认识的参数：" + arg + "（用 --help 看用法）");
                        Environment.Exit(2);
                        break;
                }
            }
            if (options.Port <= 0 || options.Port > 65535)
            {
                Console.Error.WriteLine("--port 必须是 1~65535 的整数");
                Environment.Exit(2);
            }
            if (options.Source != "mic" && options.Source != "tone")
            {
                Console.Error.WriteLine("--source 只支持 mic / tone");
                Environment.Exit(2);
            }
            return options;
        }

        private static string Next(string[] args, ref int i, string name)
        {
            if (i + 1 >= args.Length)
            {
                Console.Error.WriteLine(name + " 缺少参数值");
                Environment.Exit(2);
            }
            i += 1;
            return args[i];
        }

        private static int ParseInt(string text, int fallback)
        {
            int value;
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        public static void PrintHelp()
        {
            Console.WriteLine("语音采集客户端（Windows 单文件 exe）");
            Console.WriteLine();
            Console.WriteLine("  VoiceCaptureClient.exe [选项]");
            Console.WriteLine();
            Console.WriteLine("  --port <n>        监听端口，默认 8901（只绑 127.0.0.1）");
            Console.WriteLine("  --token <s>       可选令牌：给了就校验；不给则只按来源白名单放行（本机演示）");
            Console.WriteLine("  --page <url>      医生端地址（拼页面地址；它的 origin 自动加入允许来源）");
            Console.WriteLine("  --allow-origin <o> 额外允许来源，逗号分隔（默认已含 127.0.0.1/localhost:8787）");
            Console.WriteLine("  --source mic|tone 采集源：mic = 真麦克风（默认）；tone = 合成音频（自测）");
            Console.WriteLine("  --device <编号|名字片段>  用哪一块录音设备；不给 = 系统默认输入设备");
            Console.WriteLine("                    多块采集卡时必须指定：默认设备会随其他程序/插拔变化，且界面上看不出来");
            Console.WriteLine("  --list-devices    列出本机录音设备（JSON）后退出，不监听端口、不打开设备");
            Console.WriteLine("  --tray            启动后隐藏控制台、常驻右下角托盘（点图标即可配置录音设备）");
            Console.WriteLine("  --no-tray         强制控制台模式（覆盖配置里存的 tray）");
            Console.WriteLine("  --autostart on|off|status");
            Console.WriteLine("                    开机启动（写 HKCU\\...\\Run，按用户生效，不需要管理员）；on/off 后退出");
            Console.WriteLine("  --set-device <编号|名字片段|default>  写进本机配置后退出（等价于在托盘里选一次）");
            Console.WriteLine("  --print-config    打印本机配置（JSON）后退出");
            Console.WriteLine("  --settings        只打开「配置录音设备」窗口后退出（不监听端口、不采集）");
            Console.WriteLine("  --config-file <p> 用指定的配置文件（默认 %LOCALAPPDATA%\\EmrVoiceClient\\client.json）");
            Console.WriteLine("  --open            启动后用默认浏览器打开页面地址");
            Console.WriteLine("  --help            显示本说明");
            Console.WriteLine();
            Console.WriteLine("  自测（与 capture.ts 对拍，输出 JSON）：");
            Console.WriteLine("  --selftest-segments [--timeline \"2,1;1.2,0;2,1\"] [--config \"800,30,1\"]");
            Console.WriteLine("  --selftest-stall [--stall-ms 200]   无帧看门狗（设备中途掉线 → E_CAPTURE_SOURCE_STALLED）");
            Console.WriteLine();
            Console.WriteLine("  诚实边界：音频只在本机内存里经过；转发后即丢，客户端不落盘。");
        }
    }

    /* ============================== 录音设备（多块采集卡时选哪一块） ============================== */

    internal sealed class AudioDevice
    {
        public int Index;
        public string Name = "";
        public int Channels;
    }

    /**
     * 录音设备枚举与选择（winmm）。
     *
     * 为什么需要：系统「默认输入设备」是**单点**，别的程序改一次、插拔一次、驱动更新一次，
     * 它就可能换掉，而采集端不会知道 —— 结果是录到另一只麦克风，界面上还看不出来。
     * 在病历场景里这是内容来源错误，比"录不出来"严重。
     *
     * 纪律：**指定了设备却找不到 → 拒绝启动**（`DeviceSelectionException`），绝不回落系统默认。
     * 静默回落正是"录错源却没人知道"的成因。
     */
    internal static class AudioDevices
    {
        /** WAVE_MAPPER：交给系统默认输入设备（只有"没指定"时才用它） */
        public const int MapperId = -1;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WAVEINCAPS
        {
            public ushort wMid;
            public ushort wPid;
            public uint vDriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szPname;
            public uint dwFormats;
            public ushort wChannels;
            public ushort wReserved1;
        }

        [DllImport("winmm.dll")]
        private static extern int waveInGetNumDevs();

        /* 必须显式要 W 版：设备名常含中文，A 版（默认）会按当前 ANSI 代码页变成乱码 */
        [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "waveInGetDevCapsW")]
        private static extern int waveInGetDevCaps(UIntPtr deviceId, ref WAVEINCAPS caps, uint size);

        /** 枚举本机录音设备（**只读**：不打开设备、不占麦克风） */
        public static List<AudioDevice> List()
        {
            List<AudioDevice> devices = new List<AudioDevice>();
            int count = waveInGetNumDevs();
            for (int i = 0; i < count; i += 1)
            {
                WAVEINCAPS caps = new WAVEINCAPS();
                int code = waveInGetDevCaps(new UIntPtr(unchecked((uint)i)), ref caps, (uint)Marshal.SizeOf(typeof(WAVEINCAPS)));
                if (code != 0) continue;
                AudioDevice device = new AudioDevice();
                device.Index = i;
                device.Name = (caps.szPname ?? "").Trim();
                device.Channels = caps.wChannels;
                devices.Add(device);
            }
            return devices;
        }

        /**
         * 把 `--device <编号|名字片段>` 解析成设备；空 = 系统默认（返回 null）。
         * 名字片段比编号稳：插拔之后编号会重排，名字不会。
         */
        public static AudioDevice Resolve(string spec)
        {
            if (spec == null || spec.Trim().Length == 0) return null;
            string wanted = spec.Trim();
            List<AudioDevice> all = List();

            int index;
            if (int.TryParse(wanted, NumberStyles.Integer, CultureInfo.InvariantCulture, out index))
            {
                foreach (AudioDevice device in all)
                {
                    if (device.Index == index) return device;
                }
                throw new DeviceSelectionException(
                    "E_CAPTURE_DEVICE_NOT_FOUND",
                    "没有编号 " + index + " 的录音设备（本机共 " + all.Count + " 块）",
                    DescribeChoices(all));
            }

            List<AudioDevice> hits = new List<AudioDevice>();
            foreach (AudioDevice device in all)
            {
                if (device.Name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) hits.Add(device);
            }
            if (hits.Count == 1) return hits[0];
            if (hits.Count == 0)
            {
                throw new DeviceSelectionException(
                    "E_CAPTURE_DEVICE_NOT_FOUND",
                    "没有名字里含「" + wanted + "」的录音设备（本机共 " + all.Count + " 块）",
                    DescribeChoices(all));
            }
            /* 多个命中不能"随便挑一个"：挑错了就是录错源，而且没人会发现 */
            throw new DeviceSelectionException(
                "E_CAPTURE_DEVICE_AMBIGUOUS",
                "「" + wanted + "」匹配到 " + hits.Count + " 块设备：" + Names(hits),
                "把名字写长一些（能区分到一块），或者直接用编号 --device <编号>");
        }

        public static string DescribeChoices(List<AudioDevice> devices)
        {
            if (devices.Count == 0)
            {
                return "本机没有可用的录音设备：确认采集卡已插好、驱动已装（设备管理器 → 声音、视频和游戏控制器），然后重新运行本客户端";
            }
            return "可用设备（用 --device <编号> 或 --device <名字片段> 指定）：" + Names(devices);
        }

        public static string Names(List<AudioDevice> devices)
        {
            StringBuilder sb = new StringBuilder();
            foreach (AudioDevice device in devices)
            {
                if (sb.Length > 0) sb.Append("；");
                sb.Append("#").Append(device.Index).Append(" ").Append(device.Name);
                if (device.Channels > 0) sb.Append("（").Append(device.Channels).Append(" 通道）");
            }
            return sb.ToString();
        }

        public static string ToJson(List<AudioDevice> devices)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"devices\":[");
            for (int i = 0; i < devices.Count; i += 1)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"index\":").Append(devices[i].Index)
                  .Append(",\"name\":").Append(Json.Quote(devices[i].Name))
                  .Append(",\"channels\":").Append(devices[i].Channels)
                  .Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }
    }

    /** 选设备失败（启动阶段，不监听端口）：带"怎么办"，与采集源的错误同一个形状 */
    internal sealed class DeviceSelectionException : Exception
    {
        public readonly string Code;
        public readonly string HowTo;

        public DeviceSelectionException(string code, string message, string howTo) : base(message)
        {
            Code = code;
            HowTo = howTo;
        }
    }

    /**
     * 无帧看门狗：采集卡中途被拔出 / 被别的程序独占时，waveIn 不再回调 ——
     * 采集端看到的只是"没有新帧"，而页面上表现为**计时停住**，看起来像卡死。
     *
     * 这里把"多久没收到帧"变成一条明确的错误（`E_CAPTURE_SOURCE_STALLED`），
     * 经 `/hello` 的 `sourceProblem` 到页面，而不是让人对着不动的秒数猜。
     */
    internal sealed class FrameWatch
    {
        private readonly long timeoutMs;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private long lastMs;

        public FrameWatch(int timeoutMs)
        {
            this.timeoutMs = timeoutMs <= 0 ? 3000 : timeoutMs;
        }

        public void Reset() { lastMs = clock.ElapsedMilliseconds; }

        public long IdleMs { get { return clock.ElapsedMilliseconds - lastMs; } }

        public bool Stalled { get { return IdleMs >= timeoutMs; } }
    }

    /* ============================== 音频源 ============================== */

    internal interface IAudioSource
    {
        string Label { get; }
        /** 开始采集；每凑满一帧回调一次（startSec 必须能表示 0.5 的奇数倍，不能用整秒）。 */
        void Run(Action<double, bool, byte[]> onFrame, Func<bool> keepRunning);
        /** 停止（必须立即兑现，不强求源自己抛错） */
        void Stop();
    }

    internal sealed class MicSource : IAudioSource
    {
        public const int TargetRate = 16000;
        public const double VadRms = 0.01;
        private const int FrameSamples = 8000; // 0.5s @16k
        private const int BufferCount = 8;
        /**
         * 多久没有帧就判定采集源停摆：正常回调约 100ms 一次，3s ≈ 30 个缓冲周期 ——
         * 既不会把"医生在沉思"误判成故障（静音也照样产帧），也不会让人对着不动的秒数等太久。
         */
        public const int StallTimeoutMs = 3000;

        private const uint CallbackFunction = 0x00030000;
        private const int WaveFormatPcm = 1;

        private readonly int deviceId;
        private readonly string deviceName;
        private readonly FrameWatch watch = new FrameWatch(StallTimeoutMs);

        private readonly object gate = new object();
        private readonly List<IntPtr> headers = new List<IntPtr>();
        private readonly List<IntPtr> datas = new List<IntPtr>();
        private IntPtr handle = IntPtr.Zero;
        private WaveInProc callback; // 必须活到 waveInClose：回调被 GC 掉会直接崩溃
        private volatile bool stopping;
        private int deviceRate;
        private int bytesPerSample = 2;
        private int frameCount;
        private double[] pending = new double[0];
        private double readPos;
        private int producedSamples;
        private Action<double, bool, byte[]> sink;

        /**
         * `deviceId` = `AudioDevices.MapperId` 表示系统默认；否则是指定设备。
         * 回报里带**实际设备名与采样率**：多卡环境下"到底用了哪块"必须能核对，
         * 否则医生以为录的是诊室卡、实际录的是板载麦克风，而且谁也看不出来。
         */
        public MicSource(int deviceId, string deviceName)
        {
            this.deviceId = deviceId;
            this.deviceName = deviceName == null ? "" : deviceName;
        }

        public string Label
        {
            get
            {
                string name = deviceName.Length > 0
                    ? deviceName + " #" + deviceId
                    : "系统默认录音设备";
                return deviceRate > 0
                    ? name + "；" + deviceRate + " Hz / 单声道 / 16-bit"
                    : name;
            }
        }

        public void Run(Action<double, bool, byte[]> onFrame, Func<bool> keepRunning)
        {
            sink = onFrame;
            int opened = TryOpen(16000);
            if (opened != 0) opened = TryOpen(44100);
            if (opened != 0) opened = TryOpen(48000);
            if (opened != 0)
            {
                throw new CaptureSourceException(
                    "E_CAPTURE_NO_DEVICE",
                    "打不开录音设备「" + Label + "」（winmm 错误码 " + opened + "）",
                    deviceId == AudioDevices.MapperId
                        ? "确认采集卡/麦克风已接好，并在「设置 → 隐私 → 麦克风」允许桌面应用访问；多块卡时用 --device <编号> 指定（--list-devices 可列出），然后重新点「开始采集」"
                        : "确认这块设备还在（可能被拔掉或被别的程序独占）：--list-devices 可列出当前可用设备；换一块可用 --device <编号> 指定，然后重新点「开始采集」");
            }
            /* 打开成功才开始计时：设备打开了却一帧都不来（被独占 / 驱动停了）同样要报出来 */
            watch.Reset();
            while (!stopping && keepRunning())
            {
                if (watch.Stalled)
                {
                    Close();
                    throw new CaptureSourceException(
                        "E_CAPTURE_SOURCE_STALLED",
                        "「" + Label + "」已经 " + (StallTimeoutMs / 1000) + " 秒没有送来音频（采集卡可能被拔出、被其他程序独占，或驱动停了）",
                        "检查采集卡/USB 连接，确认它没被其他录音程序占用；多块卡时用 --device <编号> 选对那一块；然后重新点「开始采集」");
                }
                Thread.Sleep(50);
            }
            Close();
        }

        private int TryOpen(int rate)
        {
            WAVEFORMATEX format = new WAVEFORMATEX();
            format.wFormatTag = WaveFormatPcm;
            format.nChannels = 1;
            format.nSamplesPerSec = (uint)rate;
            format.wBitsPerSample = 16;
            format.nBlockAlign = (ushort)(format.nChannels * format.wBitsPerSample / 8);
            format.nAvgBytesPerSec = (uint)(rate * format.nBlockAlign);
            format.cbSize = 0;

            callback = OnWaveIn;
            IntPtr h;
            int code = waveInOpen(out h, new UIntPtr(unchecked((uint)deviceId)), ref format, callback, IntPtr.Zero, CallbackFunction);
            if (code != 0) return code;
            handle = h;
            deviceRate = rate;
            stopping = false;

            int bufferBytes = Math.Max(3200, (int)(rate * 0.1) * bytesPerSample);
            for (int i = 0; i < BufferCount; i += 1)
            {
                IntPtr data = Marshal.AllocHGlobal(bufferBytes);
                IntPtr header = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
                WAVEHDR hdr = new WAVEHDR();
                hdr.lpData = data;
                hdr.dwBufferLength = (uint)bufferBytes;
                Marshal.StructureToPtr(hdr, header, false);
                int prep = waveInPrepareHeader(handle, header, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
                if (prep != 0) { FreeBuffers(handle); waveInClose(handle); handle = IntPtr.Zero; return prep; }
                int add = waveInAddBuffer(handle, header, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
                if (add != 0) { FreeBuffers(handle); waveInClose(handle); handle = IntPtr.Zero; return add; }
                headers.Add(header);
                datas.Add(data);
            }
            int start = waveInStart(handle);
            if (start != 0) { Close(); return start; }
            return 0;
        }

        private void OnWaveIn(IntPtr hwi, uint msg, IntPtr instance, IntPtr param1, IntPtr param2)
        {
            if (msg != 0x03C0) return; // WIM_DATA
            if (stopping) return;
            try
            {
                WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(param1, typeof(WAVEHDR));
                int bytes = (int)header.dwBytesRecorded;
                if (bytes > 0)
                {
                    /* 有数据就先喂看门狗：判断"设备还在送音频"要基于真实帧，不看墙上时钟 */
                    watch.Reset();
                    byte[] chunk = new byte[bytes];
                    Marshal.Copy(header.lpData, chunk, 0, bytes);
                    Process(chunk);
                }
                if (!stopping && handle != IntPtr.Zero)
                {
                    waveInAddBuffer(handle, param1, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
                }
            }
            catch
            {
                /* 回调里抛错会穿过 P/Invoke 边界 —— 一律吞掉，由调用方看"没有帧" */
            }
        }

        private void Process(byte[] raw)
        {
            short[] samples = BytesToShorts(raw);
            short[] at16k = deviceRate == TargetRate ? samples : Resample(samples, deviceRate, TargetRate);
            lock (gate)
            {
                for (int i = 0; i < at16k.Length; i += 1)
                {
                    buffer[frameCount] = at16k[i];
                    frameCount += 1;
                    if (frameCount == FrameSamples)
                    {
                        EmitFrame(buffer, FrameSamples);
                        frameCount = 0;
                    }
                }
            }
        }

        private readonly short[] buffer = new short[FrameSamples];

        private void EmitFrame(short[] source, int count)
        {
            long startSample = producedSamples;
            producedSamples += count;
            /* 必须是小数：第 4 帧从 1.5s 起，用整秒会把 1.0s 重复播一遍（分片时间轴当场自相矛盾） */
            double startSec = startSample / (double)TargetRate;
            byte[] pcm = ShortsToBytes(source, count);
            bool voiced = RmsOf(source, count) >= VadRms;
            if (sink != null) sink(startSec, voiced, pcm);
        }

        private short[] Resample(short[] input, int inputRate, int targetRate)
        {
            /* 流式线性插值（与 capture-web.js 的 resampleLinear 同思路）：不能等整段录完。 */
            List<double> outSamples = new List<double>();
            double step = inputRate / (double)targetRate;
            int total = lastPending.Length + input.Length;
            double[] merged = new double[total];
            Array.Copy(lastPending, merged, lastPending.Length);
            for (int i = 0; i < input.Length; i += 1) merged[lastPending.Length + i] = input[i];
            double pos = readPos;
            while (pos + 1 < merged.Length)
            {
                int i = (int)Math.Floor(pos);
                double frac = pos - i;
                outSamples.Add(merged[i] * (1 - frac) + merged[i + 1] * frac);
                pos += step;
            }
            int consumed = (int)Math.Floor(pos);
            int rest = merged.Length - consumed;
            lastPending = new double[rest];
            Array.Copy(merged, consumed, lastPending, 0, rest);
            readPos = pos - consumed;
            short[] result = new short[outSamples.Count];
            for (int i = 0; i < result.Length; i += 1)
            {
                double v = outSamples[i];
                if (v > 32767) v = 32767;
                if (v < -32768) v = -32768;
                result[i] = (short)Math.Round(v);
            }
            return result;
        }

        private double[] lastPending = new double[0];

        public void Stop()
        {
            stopping = true;
            Close();
        }

        private void Close()
        {
            IntPtr h;
            lock (gate)
            {
                h = handle;
                if (h == IntPtr.Zero) return;
                handle = IntPtr.Zero;
                stopping = true;
            }
            try { waveInStop(h); } catch { }
            try { waveInReset(h); } catch { }
            /* 回调可能还在驱动线程上跑：给它一点时间退出，再释放它正在读的缓冲区。
               省这 50ms 的代价是极小概率的访问冲突 —— 那种崩溃现场没人能解释。 */
            Thread.Sleep(50);
            lock (gate) { FreeBuffers(h); }
            try { waveInClose(h); } catch { }
        }

        private void FreeBuffers(IntPtr h)
        {
            for (int i = 0; i < headers.Count; i += 1)
            {
                try { waveInUnprepareHeader(h, headers[i], (uint)Marshal.SizeOf(typeof(WAVEHDR))); } catch { }
                Marshal.FreeHGlobal(headers[i]);
            }
            for (int i = 0; i < datas.Count; i += 1) Marshal.FreeHGlobal(datas[i]);
            headers.Clear();
            datas.Clear();
        }

        private static short[] BytesToShorts(byte[] bytes)
        {
            short[] result = new short[bytes.Length / 2];
            for (int i = 0; i < result.Length; i += 1) result[i] = BitConverter.ToInt16(bytes, i * 2);
            return result;
        }

        private static byte[] ShortsToBytes(short[] samples, int count)
        {
            byte[] bytes = new byte[count * 2];
            for (int i = 0; i < count; i += 1)
            {
                bytes[i * 2] = (byte)(samples[i] & 0xFF);
                bytes[i * 2 + 1] = (byte)((samples[i] >> 8) & 0xFF);
            }
            return bytes;
        }

        private static double RmsOf(short[] samples, int count)
        {
            double sum = 0;
            for (int i = 0; i < count; i += 1)
            {
                double v = samples[i] / 32768.0;
                sum += v * v;
            }
            return count == 0 ? 0 : Math.Sqrt(sum / count);
        }

        /* ---------- winmm ---------- */

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct WAVEFORMATEX
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEHDR
        {
            public IntPtr lpData;
            public uint dwBufferLength;
            public uint dwBytesRecorded;
            public IntPtr dwUser;
            public uint dwFlags;
            public uint dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }

        private delegate void WaveInProc(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

        [DllImport("winmm.dll")] private static extern int waveInOpen(out IntPtr hwi, UIntPtr deviceId, ref WAVEFORMATEX format, WaveInProc callback, IntPtr instance, uint flags);
        [DllImport("winmm.dll")] private static extern int waveInPrepareHeader(IntPtr hwi, IntPtr header, uint size);
        [DllImport("winmm.dll")] private static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr header, uint size);
        [DllImport("winmm.dll")] private static extern int waveInAddBuffer(IntPtr hwi, IntPtr header, uint size);
        [DllImport("winmm.dll")] private static extern int waveInStart(IntPtr hwi);
        [DllImport("winmm.dll")] private static extern int waveInStop(IntPtr hwi);
        [DllImport("winmm.dll")] private static extern int waveInReset(IntPtr hwi);
        [DllImport("winmm.dll")] private static extern int waveInClose(IntPtr hwi);
    }

    internal sealed class ToneSource : IAudioSource
    {
        private readonly List<TimelineStep> timeline;
        private volatile bool stopping;

        public ToneSource(List<TimelineStep> timeline)
        {
            this.timeline = timeline;
        }

        public string Label
        {
            get { return "合成音频（tone；不是麦克风，仅用于自测）"; }
        }

        public void Run(Action<double, bool, byte[]> onFrame, Func<bool> keepRunning)
        {
            const int rate = 16000;
            const int frameSamples = 8000;
            double produced = 0;
            foreach (TimelineStep step in timeline)
            {
                if (stopping || !keepRunning()) return;
                int frames = Math.Max(1, (int)Math.Round(step.Seconds / 0.5));
                for (int f = 0; f < frames; f += 1)
                {
                    if (stopping || !keepRunning()) return;
                    Thread.Sleep(500);
                    short[] pcm = new short[frameSamples];
                    if (step.Voiced)
                    {
                        for (int i = 0; i < frameSamples; i += 1)
                        {
                            pcm[i] = (short)Math.Round(Math.Sin(2 * Math.PI * 440 * (produced + i) / rate) * 8192);
                        }
                    }
                    onFrame(produced / rate, step.Voiced, ShortsToBytes(pcm));
                    produced += frameSamples;
                }
            }
        }

        public void Stop()
        {
            stopping = true;
        }

        private static byte[] ShortsToBytes(short[] samples)
        {
            byte[] bytes = new byte[samples.Length * 2];
            for (int i = 0; i < samples.Length; i += 1)
            {
                bytes[i * 2] = (byte)(samples[i] & 0xFF);
                bytes[i * 2 + 1] = (byte)((samples[i] >> 8) & 0xFF);
            }
            return bytes;
        }
    }

    internal sealed class TimelineStep
    {
        public double Seconds;
        public bool Voiced;
    }

    internal sealed class CaptureSourceException : Exception
    {
        public readonly string Code;
        public readonly string HowTo;

        public CaptureSourceException(string code, string message, string howTo) : base(message)
        {
            Code = code;
            HowTo = howTo;
        }
    }

    /* ============================== 分片（与 capture.ts 同规则） ============================== */

    internal sealed class SegmentConfig
    {
        public int SilenceMs = 800;
        public int MaxSeconds = 30;
        public int MinSeconds = 1;

        public static SegmentConfig FromJson(object body)
        {
            Dictionary<string, object> map = body as Dictionary<string, object>;
            SegmentConfig config = new SegmentConfig();
            if (map == null) return config;
            config.SilenceMs = ReadPositiveInt(map, "silenceMs", 800);
            config.MaxSeconds = ReadPositiveInt(map, "maxSeconds", 30);
            config.MinSeconds = ReadPositiveInt(map, "minSeconds", 1);
            if (config.MinSeconds >= config.MaxSeconds) throw new ConfigException("segment.minSeconds(" + config.MinSeconds + ") 必须小于 maxSeconds(" + config.MaxSeconds + ")：否则每一片都会被自己丢弃");
            if (config.MaxSeconds > 120) throw new ConfigException("segment.maxSeconds 不得超过 120s，实际 " + config.MaxSeconds);
            if (config.SilenceMs >= config.MaxSeconds * 1000) throw new ConfigException("segment.silenceMs(" + config.SilenceMs + ") 必须小于 maxSeconds 对应的毫秒数(" + config.MaxSeconds * 1000 + ")");
            return config;
        }

        private static int ReadPositiveInt(Dictionary<string, object> map, string key, int fallback)
        {
            if (!map.ContainsKey(key)) return fallback;
            object raw = map[key];
            if (!(raw is double)) throw new ConfigException(key + " 必须是正整数（拒绝静默取默认值）");
            double value = (double)raw;
            if (value <= 0 || value != Math.Floor(value)) throw new ConfigException(key + " 必须是正整数，实际 " + value.ToString(CultureInfo.InvariantCulture));
            if (value > 1000000) throw new ConfigException(key + " 过大：" + value.ToString(CultureInfo.InvariantCulture));
            return (int)value;
        }
    }

    internal sealed class ConfigException : Exception
    {
        public ConfigException(string message) : base(message) { }
    }

    internal sealed class Frame
    {
        public double StartSec;
        public double EndSec;
        public bool Voiced;
        public byte[] Pcm;
    }

    internal sealed class Plan
    {
        public int Index;
        public double StartSec;
        public double EndSec;
        public string Reason;
    }

    internal sealed class Chunk
    {
        public Plan Plan;
        public byte[] Audio;
    }

    internal sealed class Planner
    {
        private readonly SegmentConfig config;
        private int droppedShort;
        private int nextIndex = 1;
        private bool open;
        private double start;
        private bool hasCarry;
        private double carry;
        private double silenceSec;
        private double previousEnd = -1;

        public Planner(SegmentConfig config) { this.config = config; }

        public bool Open { get { return open; } }
        public double OpenStartSec { get { return start; } }
        public bool HasOpen { get { return open; } }
        public int DroppedShort { get { return droppedShort; } }

        public List<Plan> FeedFrame(double startSec, double endSec, bool voiced)
        {
            if (endSec < startSec || startSec < previousEnd - 1e-9)
            {
                throw new ConfigException("帧时间轴必须单调不减：收到 [" + startSec.ToString("R", CultureInfo.InvariantCulture) + ", " + endSec.ToString("R", CultureInfo.InvariantCulture) + "]");
            }
            List<Plan> output = new List<Plan>();
            if (!open)
            {
                if (!voiced)
                {
                    previousEnd = endSec;
                    return output;
                }
                start = hasCarry ? carry : startSec;
                open = true;
            }
            silenceSec = voiced ? 0 : silenceSec + (endSec - startSec);
            if (endSec - start >= config.MaxSeconds)
            {
                Finalize(endSec, "maxSeconds", output);
            }
            else if (!voiced && silenceSec * 1000 >= config.SilenceMs)
            {
                Finalize(endSec, "silence", output);
            }
            previousEnd = endSec;
            return output;
        }

        public List<Plan> Finish(double atSec)
        {
            List<Plan> output = new List<Plan>();
            Finalize(atSec, "manual-stop", output);
            previousEnd = atSec;
            return output;
        }

        private void Finalize(double endSec, string reason, List<Plan> output)
        {
            if (!open) return;
            double seconds = endSec - start;
            if (seconds <= 0) throw new ConfigException("定稿时刻 " + endSec + " 不晚于分片起点 " + start);
            if (seconds < config.MinSeconds)
            {
                droppedShort += 1;
            }
            else
            {
                Plan plan = new Plan();
                plan.Index = nextIndex;
                plan.StartSec = start;
                plan.EndSec = endSec;
                plan.Reason = reason;
                nextIndex += 1;
                output.Add(plan);
            }
            carry = endSec;
            hasCarry = true;
            open = false;
            silenceSec = 0;
        }
    }

    internal sealed class Assembler
    {
        private readonly Planner planner;
        private readonly List<Frame> frames = new List<Frame>();
        private const double Eps = 1e-9;

        public Assembler(SegmentConfig config) { planner = new Planner(config); }
        public double OpenStartSec { get { return planner.OpenStartSec; } }
        public bool HasOpen { get { return planner.HasOpen; } }
        public int DroppedShort { get { return planner.DroppedShort; } }

        public List<Chunk> Feed(Frame frame)
        {
            frames.Add(frame);
            return Take(planner.FeedFrame(frame.StartSec, frame.EndSec, frame.Voiced));
        }

        public List<Chunk> Finish(double atSec)
        {
            return Take(planner.Finish(atSec));
        }

        private List<Chunk> Take(List<Plan> plans)
        {
            List<Chunk> output = new List<Chunk>();
            foreach (Plan plan in plans)
            {
                while (frames.Count > 0 && frames[0].EndSec <= plan.StartSec + Eps) frames.RemoveAt(0);
                List<Frame> taken = new List<Frame>();
                while (frames.Count > 0 && frames[0].EndSec <= plan.EndSec + Eps)
                {
                    taken.Add(frames[0]);
                    frames.RemoveAt(0);
                }
                int total = 0;
                foreach (Frame frame in taken) total += frame.Pcm.Length;
                byte[] pcm = new byte[total];
                int offset = 0;
                foreach (Frame frame in taken)
                {
                    Array.Copy(frame.Pcm, 0, pcm, offset, frame.Pcm.Length);
                    offset += frame.Pcm.Length;
                }
                Chunk chunk = new Chunk();
                chunk.Plan = plan;
                chunk.Audio = Wav.Encode(pcm);
                output.Add(chunk);
            }
            return output;
        }
    }

    internal static class Wav
    {
        public static byte[] Encode(byte[] pcm)
        {
            if (pcm.Length % 2 != 0) throw new ConfigException("PCM 字节数不是 2 的整数倍：采集端必须产出 16-bit 小端 PCM");
            byte[] output = new byte[44 + pcm.Length];
            WriteAscii(output, 0, "RIFF");
            WriteU32(output, 4, 36 + pcm.Length);
            WriteAscii(output, 8, "WAVE");
            WriteAscii(output, 12, "fmt ");
            WriteU32(output, 16, 16);
            WriteU16(output, 20, 1);
            WriteU16(output, 22, 1);
            WriteU32(output, 24, 16000);
            WriteU32(output, 28, 32000);
            WriteU16(output, 32, 2);
            WriteU16(output, 34, 16);
            WriteAscii(output, 36, "data");
            WriteU32(output, 40, pcm.Length);
            Array.Copy(pcm, 0, output, 44, pcm.Length);
            return output;
        }

        private static void WriteAscii(byte[] target, int offset, string text)
        {
            for (int i = 0; i < text.Length; i += 1) target[offset + i] = (byte)text[i];
        }

        private static void WriteU16(byte[] target, int offset, int value)
        {
            target[offset] = (byte)(value & 0xFF);
            target[offset + 1] = (byte)((value >> 8) & 0xFF);
        }

        private static void WriteU32(byte[] target, int offset, int value)
        {
            target[offset] = (byte)(value & 0xFF);
            target[offset + 1] = (byte)((value >> 8) & 0xFF);
            target[offset + 2] = (byte)((value >> 16) & 0xFF);
            target[offset + 3] = (byte)((value >> 24) & 0xFF);
        }
    }

    /* ============================== 桥（客户端 ↔ 页面） ============================== */

    internal sealed class Bridge
    {
        private readonly object gate = new object();
        private readonly string sessionId;
        private readonly Assembler assembler;
        private readonly List<Chunk> queue = new List<Chunk>();
        private readonly List<Dictionary<string, object>> failures = new List<Dictionary<string, object>>();
        private string state = "idle";
        private int finalized;
        private int delivered;
        private double elapsedSec;
        private bool voiced;
        private double level;

        public Bridge(string sessionId, SegmentConfig config)
        {
            this.sessionId = sessionId;
            assembler = new Assembler(config);
        }

        public string SessionId { get { return sessionId; } }

        public void Feed(Frame frame)
        {
            lock (gate)
            {
                if (state == "done") return;
                state = "recording";
                elapsedSec = frame.EndSec;
                voiced = frame.Voiced;
                level = Rms(frame.Pcm);
                Push(assembler.Feed(frame));
            }
        }

        public void Finish(double atSec)
        {
            lock (gate)
            {
                if (state == "done") return;
                if (atSec > elapsedSec) elapsedSec = atSec;
                voiced = false;
                level = 0;
                Push(assembler.Finish(atSec));
                state = "done";
            }
        }

        private void Push(List<Chunk> chunks)
        {
            foreach (Chunk chunk in chunks)
            {
                finalized += 1;
                queue.Add(chunk);
            }
        }

        public Dictionary<string, object> Progress()
        {
            lock (gate)
            {
                Dictionary<string, object> map = new Dictionary<string, object>();
                map["sessionId"] = sessionId;
                map["state"] = state;
                map["finalized"] = finalized;
                map["delivered"] = delivered;
                map["failed"] = failures.Count;
                map["shortDropped"] = assembler.DroppedShort;
                map["elapsedSec"] = elapsedSec;
                map["currentChunkSec"] = assembler.HasOpen ? Math.Max(0, elapsedSec - assembler.OpenStartSec) : 0;
                map["voiced"] = voiced;
                map["level"] = level;
                return map;
            }
        }

        public Dictionary<string, object> Next()
        {
            lock (gate)
            {
                if (queue.Count > 0)
                {
                    Chunk head = queue[0];
                    Dictionary<string, object> segment = new Dictionary<string, object>();
                    segment["index"] = head.Plan.Index;
                    segment["startSec"] = head.Plan.StartSec;
                    segment["endSec"] = head.Plan.EndSec;
                    Dictionary<string, object> map = new Dictionary<string, object>();
                    map["kind"] = "segment";
                    map["sessionId"] = sessionId;
                    map["segment"] = segment;
                    map["audioBytes"] = head.Audio.Length;
                    return map;
                }
                Dictionary<string, object> result = new Dictionary<string, object>();
                result["sessionId"] = sessionId;
                if (state == "done")
                {
                    result["kind"] = "done";
                    result["total"] = finalized;
                    result["delivered"] = delivered;
                    result["failures"] = failures;
                    result["shortDropped"] = assembler.DroppedShort;
                }
                else
                {
                    result["kind"] = "empty";
                    result["state"] = state;
                    result["finalized"] = finalized;
                }
                return result;
            }
        }

        public AckResult Ack(int index, bool ok, string code, string message)
        {
            lock (gate)
            {
                if (queue.Count == 0) return AckResult.Fail("E_BRIDGE_SEGMENT_GONE", "第 " + index + " 段不在队列里（可能已经确认过了）");
                Chunk head = queue[0];
                if (head.Plan.Index != index)
                {
                    return AckResult.Fail("E_BRIDGE_ACK_OUT_OF_ORDER", "第 " + index + " 段不是当前待确认的那一段（当前是第 " + head.Plan.Index + " 段）：拒绝按序之外的确认");
                }
                queue.RemoveAt(0);
                delivered += 1;
                if (!ok)
                {
                    Dictionary<string, object> failure = new Dictionary<string, object>();
                    failure["index"] = head.Plan.Index;
                    failure["startSec"] = head.Plan.StartSec;
                    failure["endSec"] = head.Plan.EndSec;
                    failure["code"] = code.Length == 0 ? "E_CAPTURE_SEGMENT_FAILED" : code;
                    failure["message"] = message.Length == 0 ? "该段在页面上传或转写环节失败（原因未回报）" : message;
                    failures.Add(failure);
                }
                return AckResult.Success(delivered);
            }
        }

        public byte[] AudioOf(int index)
        {
            lock (gate)
            {
                if (queue.Count == 0) return null;
                return queue[0].Plan.Index == index ? queue[0].Audio : null;
            }
        }

        private static double Rms(byte[] pcm)
        {
            int samples = pcm.Length / 2;
            if (samples == 0) return 0;
            double sum = 0;
            for (int i = 0; i < samples; i += 1)
            {
                short value = BitConverter.ToInt16(pcm, i * 2);
                double v = value / 32768.0;
                sum += v * v;
            }
            return Math.Min(1, Math.Sqrt(sum / samples));
        }
    }

    internal sealed class AckResult
    {
        public bool Ok;
        public int Delivered;
        public string Code;
        public string Message;

        public static AckResult Success(int delivered)
        {
            AckResult result = new AckResult();
            result.Ok = true;
            result.Delivered = delivered;
            return result;
        }

        public static AckResult Fail(string code, string message)
        {
            AckResult result = new AckResult();
            result.Code = code;
            result.Message = message;
            return result;
        }
    }

    /* ============================== 运行时 ============================== */

    internal sealed class Runtime : IDisposable
    {
        private readonly object gate = new object();
        private readonly string sourceKind;
        /* 设备不是 readonly：托盘里改完要下一次采集就生效，不必重启客户端 */
        private int micDeviceId;
        private string micDeviceName;
        private Bridge bridge;
        private IAudioSource source;
        private Thread thread;
        private volatile bool running;
        private double elapsed;
        private Dictionary<string, object> problem;
        /** 启动时就已确定的"采集源不可用"（例如配置的设备不在了）：`/hello` 立刻要能说明 */
        private Dictionary<string, object> startupProblem;
        /** Start 失败的原因码（空 = 只是"已经在采集"） */
        private string lastStartCode = "";

        public Runtime(string sourceKind, int micDeviceId, string micDeviceName, Dictionary<string, object> startupProblem)
        {
            this.sourceKind = sourceKind;
            this.micDeviceId = micDeviceId;
            this.micDeviceName = micDeviceName == null ? "" : micDeviceName;
            this.startupProblem = startupProblem;
        }

        /**
         * 托盘里改设备：只换"下一次采集用谁"，不动正在跑的那一次（打断它等于把这一段作废）。
         * 返回 true = 当前空闲，下一次 /start 立刻生效；false = 正在采集，等这次结束。
         */
        public bool SetDeviceFromSpec(string spec)
        {
            int id = AudioDevices.MapperId;
            string name = "";
            if (spec != null && spec.Trim().Length > 0)
            {
                AudioDevice device = AudioDevices.Resolve(spec);
                id = device.Index;
                name = device.Name;
            }
            lock (gate)
            {
                micDeviceId = id;
                micDeviceName = name;
                /* 选好了就清掉"设备不存在"的旧结论：否则 /start 会一直按旧错误拒绝 */
                startupProblem = null;
                lastStartCode = "";
                return !running;
            }
        }

        /** 选中的是哪一块设备（未指定编号时是系统默认） */
        private string MicName()
        {
            if (micDeviceId == AudioDevices.MapperId)
            {
                /* 启动时判定"配置的设备不在了"：名字还留着，但绝不能显示成"系统默认"
                   —— 那正是我们拒绝回落的那个错误 */
                return micDeviceName.Length > 0 ? micDeviceName + "（未找到）" : "系统默认录音设备";
            }
            return micDeviceName + " #" + micDeviceId;
        }

        public string SourceLabel
        {
            get
            {
                return sourceKind == "tone"
                    ? "合成音频（tone；不是麦克风，仅用于自测）"
                    : "Windows 麦克风（" + MicName() + "）";
            }
        }

        /**
         * `/hello` 的 `source`：页面把它直接摆在状态栏上。
         * 采集开始后取**实际打开**的设备与采样率（`MicSource.Label`），开始前只有选择结果 ——
         * "界面配了哪块"与"实际用哪块"必须能对得上。
         */
        public string SourceDescription
        {
            get
            {
                if (sourceKind == "tone") return "tone（合成音频；不是麦克风）";
                IAudioSource current;
                lock (gate) current = source;
                return current != null
                    ? "mic（" + current.Label + "）"
                    : "mic（" + MicName() + "）";
            }
        }

        public Bridge Bridge { get { lock (gate) return bridge; } }

        /** 采集期问题优先；没有就回启动时那个"配置的设备不在了" */
        public Dictionary<string, object> Problem { get { lock (gate) return problem != null ? problem : startupProblem; } }

        /** Start 返回 null 时说明为什么（空 = 就是"已经在采集"） */
        public string LastStartCode { get { lock (gate) return lastStartCode; } }

        public Bridge Start(SegmentConfig config)
        {
            lock (gate)
            {
                if (running) return null;
                lastStartCode = "";
                /* 配置的设备在启动时就找不到了：这里必须拒绝，不能回落到系统默认 */
                if (startupProblem != null)
                {
                    object code;
                    lastStartCode = startupProblem.TryGetValue("code", out code) && code != null
                        ? code.ToString()
                        : "E_CAPTURE_SOURCE_UNAVAILABLE";
                    return null;
                }
                string sessionId = "client-capture-" + (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                bridge = new Bridge(sessionId, config);
                problem = null;
                elapsed = 0;
                if (sourceKind == "tone")
                {
                    source = new ToneSource(SelfTest.DefaultTimeline());
                }
                else
                {
                    source = new MicSource(micDeviceId, micDeviceName);
                }
                running = true;
                Bridge captured = bridge;
                IAudioSource capturedSource = source;
                thread = new Thread(delegate()
                {
                    try
                    {
                        capturedSource.Run(
                            delegate(double startSec, bool voiced, byte[] pcm)
                            {
                                Frame frame = new Frame();
                                frame.StartSec = startSec;
                                frame.EndSec = startSec + (pcm.Length / 2) / 16000.0;
                                frame.Voiced = voiced;
                                frame.Pcm = pcm;
                                lock (gate) elapsed = frame.EndSec;
                                captured.Feed(frame);
                            },
                            delegate() { return running; });
                    }
                    catch (CaptureSourceException ex)
                    {
                        Dictionary<string, object> p = new Dictionary<string, object>();
                        p["code"] = ex.Code;
                        p["message"] = ex.Message;
                        p["howTo"] = ex.HowTo;
                        lock (gate) problem = p;
                    }
                    catch (Exception ex)
                    {
                        Dictionary<string, object> p = new Dictionary<string, object>();
                        p["code"] = "E_CAPTURE_SOURCE_UNKNOWN";
                        p["message"] = "采集源异常：" + ex.Message;
                        p["howTo"] = "重试一次；仍然失败请把这条错误报给运维";
                        lock (gate) problem = p;
                    }
                    finally
                    {
                        captured.Finish(elapsed);
                        running = false;
                    }
                });
                thread.IsBackground = true;
                thread.Start();
                return bridge;
            }
        }

        public void Stop()
        {
            IAudioSource capturedSource;
            Thread capturedThread;
            Bridge capturedBridge;
            lock (gate)
            {
                capturedSource = source;
                capturedThread = thread;
                capturedBridge = bridge;
                running = false;
            }
            if (capturedSource != null) capturedSource.Stop();
            if (capturedThread != null && capturedThread.IsAlive) capturedThread.Join(3000);
            if (capturedBridge != null) capturedBridge.Finish(elapsed);
        }

        public void Dispose()
        {
            try { Stop(); } catch { }
        }
    }

    /* ============================== HTTP（TcpListener：不需要 URL ACL） ============================== */

    internal sealed class BridgeServer : IDisposable
    {
        private const string Prefix = "/dictation-capture";
        private readonly TcpListener listener;
        private readonly string token;
        private readonly string pageUrl;
        private readonly List<string> allowedOrigins;
        private readonly Runtime runtime;
        private volatile bool disposed;

        public BridgeServer(int port, string token, string pageUrl, List<string> allowedOrigins, Runtime runtime)
        {
            this.token = token;
            this.pageUrl = pageUrl;
            this.allowedOrigins = allowedOrigins;
            this.runtime = runtime;
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            Thread accept = new Thread(AcceptLoop);
            accept.IsBackground = true;
            accept.Start();
        }

        private void AcceptLoop()
        {
            while (!disposed)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch { if (disposed) return; continue; }
                ThreadPool.QueueUserWorkItem(delegate(object state) { Handle((TcpClient)state); }, client);
            }
        }

        private void Handle(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 5000;
                    client.SendTimeout = 5000;
                    NetworkStream stream = client.GetStream();

                    string headerText;
                    int contentLength;
                    if (!ReadHeaders(stream, out headerText, out contentLength)) return;
                    string[] lines = headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                    string[] request = lines[0].Split(' ');
                    if (request.Length < 2) return;
                    string method = request[0].ToUpperInvariant();
                    string target = request[1];
                    int q = target.IndexOf('?');
                    string path = q >= 0 ? target.Substring(0, q) : target;
                    Dictionary<string, string> query = ParseQuery(q >= 0 ? target.Substring(q + 1) : "");
                    Dictionary<string, string> headers = ParseHeaders(lines);
                    byte[] body = ReadBody(stream, contentLength);

                    if (!path.StartsWith(Prefix, StringComparison.Ordinal))
                    {
                        WriteJson(stream, 404, Error("E_BRIDGE_NO_ROUTE", "只服务 " + Prefix + "/*：本进程不是 Web 服务"));
                        return;
                    }
                    if (method == "OPTIONS")
                    {
                        WriteEmpty(stream, 204);
                        return;
                    }
                    string provided = "";
                    string headerToken;
                    if (headers.TryGetValue("x-capture-token", out headerToken)) provided = headerToken.Trim();
                    if (provided.Length == 0)
                    {
                        string queryToken;
                        if (query.TryGetValue("token", out queryToken)) provided = queryToken.Trim();
                    }
                    if (token.Length > 0 && !string.Equals(token, provided, StringComparison.Ordinal))
                    {
                        WriteJson(stream, 401, Error("E_BRIDGE_BAD_TOKEN", "令牌不匹配：请从本地客户端打开的页面进入（页面地址里带着一次性令牌）"));
                        return;
                    }
                    /* 没启用令牌（本机演示形态）时，用 Origin 白名单代替：浏览器 JS 改不了 Origin，
                       于是别的网站拿不到 /hello、也录不了音；curl / 本机进程没有 Origin，照常放行。 */
                    string requestOrigin = "";
                    if (token.Length == 0 && headers.TryGetValue("origin", out requestOrigin) && requestOrigin.Trim().Length > 0)
                    {
                        string normalized = requestOrigin.Trim().TrimEnd('/').ToLowerInvariant();
                        if (!allowedOrigins.Contains(normalized))
                        {
                            WriteJson(stream, 403, Error("E_BRIDGE_ORIGIN_DENIED", "来源不在允许清单（" + normalized + "）：只接受医生端页面与本机进程"));
                            return;
                        }
                    }

                    string action = path.Substring(Prefix.Length);
                    HandleAction(stream, method, action, body);
                }
                catch
                {
                    /* 单次请求失败不该影响采集：连接已经断了 */
                }
            }
        }

        private void HandleAction(NetworkStream stream, string method, string action, byte[] body)
        {
            if (method == "GET" && action == "/hello")
            {
                Bridge bridge = runtime.Bridge;
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"ok\":true,\"client\":\"l0-dictation-client\",\"pageUrl\":");
                sb.Append(pageUrl.Length == 0 ? "null" : Json.Quote(pageUrl));
                sb.Append(",\"source\":").Append(Json.Quote(runtime.SourceDescription));
                sb.Append(",\"tokenRequired\":").Append(token.Length > 0 ? "true" : "false");
                sb.Append(",\"progress\":").Append(bridge == null ? "null" : Json.Serialize(bridge.Progress()));
                Dictionary<string, object> problem = runtime.Problem;
                sb.Append(",\"sourceProblem\":").Append(problem == null ? "null" : Json.Serialize(problem));
                sb.Append('}');
                WriteJson(stream, 200, sb.ToString());
                return;
            }
            if (method == "POST" && action == "/start")
            {
                try
                {
                    object parsed = body.Length == 0 ? new Dictionary<string, object>() : Json.Parse(Encoding.UTF8.GetString(body));
                    SegmentConfig config = SegmentConfig.FromJson(parsed);
                    Bridge started = runtime.Start(config);
                    if (started == null)
                    {
                        /* 采集源不可用（配置的设备不在了等）要如实说是哪一个问题，
                           不能一律回"已经在采集了"——那句会把人引到错误的方向 */
                        string code = runtime.LastStartCode;
                        if (code.Length > 0)
                        {
                            Dictionary<string, object> sourceProblem = runtime.Problem;
                            string message = "采集源不可用";
                            object text;
                            if (sourceProblem != null && sourceProblem.TryGetValue("message", out text) && text != null)
                            {
                                message = text.ToString();
                            }
                            WriteJson(stream, 200, Error(code, message));
                            return;
                        }
                        WriteJson(stream, 200, Error("E_BRIDGE_ALREADY_RUNNING", "已经在采集了：先按停止，再重新开始"));
                        return;
                    }
                    WriteJson(stream, 200, "{\"ok\":true,\"sessionId\":" + Json.Quote(started.SessionId) + "}");
                }
                catch (ConfigException ex)
                {
                    WriteJson(stream, 200, Error("E_CAPTURE_CONFIG_INVALID", ex.Message));
                }
                return;
            }
            if (method == "POST" && action == "/stop")
            {
                runtime.Stop();
                WriteJson(stream, 200, "{\"ok\":true,\"data\":{\"stopped\":true}}");
                return;
            }
            if (method == "GET" && action == "/next")
            {
                Bridge bridge = runtime.Bridge;
                if (bridge == null)
                {
                    WriteJson(stream, 200, Error("E_BRIDGE_NOT_STARTED", "还没有开始采集：请先按「开始采集」"));
                    return;
                }
                WriteJson(stream, 200, "{\"ok\":true,\"next\":" + Json.Serialize(bridge.Next()) + "}");
                return;
            }
            if (method == "POST" && action == "/ack")
            {
                Bridge bridge = runtime.Bridge;
                if (bridge == null)
                {
                    WriteJson(stream, 200, Error("E_BRIDGE_NOT_STARTED", "还没有开始采集"));
                    return;
                }
                try
                {
                    Dictionary<string, object> map = Json.Parse(Encoding.UTF8.GetString(body)) as Dictionary<string, object>;
                    if (map == null) throw new ConfigException("ack 请求体不是 JSON 对象");
                    int index = map.ContainsKey("index") ? (int)Convert.ToDouble(map["index"], CultureInfo.InvariantCulture) : 0;
                    bool ok = !(map.ContainsKey("ok") && map["ok"] is bool && (bool)map["ok"] == false);
                    string code = map.ContainsKey("code") && map["code"] is string ? (string)map["code"] : "";
                    string message = map.ContainsKey("message") && map["message"] is string ? (string)map["message"] : "";
                    AckResult result = bridge.Ack(index, ok, code, message);
                    if (result.Ok) WriteJson(stream, 200, "{\"ok\":true,\"data\":{\"delivered\":" + result.Delivered + "}}");
                    else WriteJson(stream, 200, Error(result.Code, result.Message));
                }
                catch (Exception ex)
                {
                    WriteJson(stream, 200, Error("E_BRIDGE_FAILED", "ack 解析失败：" + ex.Message));
                }
                return;
            }
            int audioIndex;
            if (method == "GET" && TryAudioIndex(action, out audioIndex))
            {
                Bridge bridge = runtime.Bridge;
                byte[] bytes = bridge == null ? null : bridge.AudioOf(audioIndex);
                if (bytes == null)
                {
                    WriteJson(stream, 404, Error("E_BRIDGE_AUDIO_RELEASED", "第 " + audioIndex + " 段的音频不在了（可能已经确认过，或段号不对）"));
                    return;
                }
                WriteBinary(stream, bytes);
                return;
            }
            WriteJson(stream, 404, Error("E_BRIDGE_NO_ROUTE", "不认识的桥端点：" + method + " " + action));
        }

        private static bool TryAudioIndex(string action, out int index)
        {
            index = 0;
            if (!action.StartsWith("/audio/", StringComparison.Ordinal)) return false;
            string text = action.Substring("/audio/".Length);
            if (text.Length == 0) return false;
            for (int i = 0; i < text.Length; i += 1)
            {
                if (text[i] < '0' || text[i] > '9') return false;
            }
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out index) && index >= 0;
        }

        private static bool ReadHeaders(NetworkStream stream, out string headerText, out int contentLength)
        {
            headerText = "";
            contentLength = 0;
            List<byte> bytes = new List<byte>();
            while (bytes.Count < 65536)
            {
                int b = stream.ReadByte();
                if (b < 0) return false;
                bytes.Add((byte)b);
                int n = bytes.Count;
                if (n >= 4 && bytes[n - 4] == '\r' && bytes[n - 3] == '\n' && bytes[n - 2] == '\r' && bytes[n - 1] == '\n') break;
            }
            headerText = Encoding.ASCII.GetString(bytes.ToArray());
            string[] lines = headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None);
            for (int i = 1; i < lines.Length; i += 1)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0) continue;
                if (string.Equals(lines[i].Substring(0, colon).Trim(), "content-length", StringComparison.OrdinalIgnoreCase))
                {
                    int.TryParse(lines[i].Substring(colon + 1).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out contentLength);
                }
            }
            return true;
        }

        private static byte[] ReadBody(NetworkStream stream, int contentLength)
        {
            if (contentLength <= 0) return new byte[0];
            byte[] body = new byte[contentLength];
            int offset = 0;
            while (offset < contentLength)
            {
                int read = stream.Read(body, offset, contentLength - offset);
                if (read <= 0) break;
                offset += read;
            }
            if (offset != contentLength)
            {
                byte[] partial = new byte[offset];
                Array.Copy(body, partial, offset);
                return partial;
            }
            return body;
        }

        private static Dictionary<string, string> ParseHeaders(string[] lines)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i += 1)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0) continue;
                map[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
            }
            return map;
        }

        private static Dictionary<string, string> ParseQuery(string query)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (query.Length == 0) return map;
            string[] pairs = query.Split('&');
            foreach (string pair in pairs)
            {
                int eq = pair.IndexOf('=');
                string key = eq >= 0 ? pair.Substring(0, eq) : pair;
                string value = eq >= 0 ? pair.Substring(eq + 1) : "";
                try { map[Uri.UnescapeDataString(key)] = Uri.UnescapeDataString(value); }
                catch { map[key] = value; }
            }
            return map;
        }

        private static void WriteJson(NetworkStream stream, int status, string body)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            WriteResponse(stream, status, "application/json; charset=utf-8", bytes);
        }

        private static void WriteBinary(NetworkStream stream, byte[] body)
        {
            WriteResponse(stream, 200, "audio/wav", body);
        }

        private static void WriteEmpty(NetworkStream stream, int status)
        {
            WriteResponse(stream, status, null, new byte[0]);
        }

        private static void WriteResponse(NetworkStream stream, int status, string contentType, byte[] body)
        {
            StringBuilder head = new StringBuilder();
            head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(StatusText(status)).Append("\r\n");
            if (contentType != null) head.Append("Content-Type: ").Append(contentType).Append("\r\n");
            head.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            head.Append("Access-Control-Allow-Origin: *\r\n");
            head.Append("Access-Control-Allow-Headers: content-type, x-capture-token\r\n");
            head.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            head.Append("Cache-Control: no-store\r\n");
            head.Append("Connection: close\r\n\r\n");
            byte[] headBytes = Encoding.ASCII.GetBytes(head.ToString());
            stream.Write(headBytes, 0, headBytes.Length);
            if (body.Length > 0) stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        private static string StatusText(int status)
        {
            if (status == 200) return "OK";
            if (status == 204) return "No Content";
            if (status == 401) return "Unauthorized";
            if (status == 404) return "Not Found";
            return "OK";
        }

        private static string Error(string code, string message)
        {
            return "{\"ok\":false,\"code\":" + Json.Quote(code) + ",\"message\":" + Json.Quote(message) + "}";
        }

        public void Dispose()
        {
            disposed = true;
            try { listener.Stop(); } catch { }
        }
    }

    /* ============================== 极简 JSON ============================== */

    internal static class Json
    {
        public static object Parse(string text)
        {
            int i = 0;
            object value = ParseValue(text, ref i);
            return value;
        }

        private static object ParseValue(string text, ref int i)
        {
            Skip(text, ref i);
            if (i >= text.Length) return null;
            char c = text[i];
            if (c == '{') return ParseObject(text, ref i);
            if (c == '[') return ParseArray(text, ref i);
            if (c == '"') return ParseString(text, ref i);
            if (text.Substring(i).StartsWith("true")) { i += 4; return true; }
            if (text.Substring(i).StartsWith("false")) { i += 5; return false; }
            if (text.Substring(i).StartsWith("null")) { i += 4; return null; }
            return ParseNumber(text, ref i);
        }

        private static Dictionary<string, object> ParseObject(string text, ref int i)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            i += 1;
            while (true)
            {
                Skip(text, ref i);
                if (i >= text.Length) break;
                if (text[i] == '}') { i += 1; break; }
                if (text[i] == ',') { i += 1; continue; }
                string key = ParseString(text, ref i);
                Skip(text, ref i);
                if (i < text.Length && text[i] == ':') i += 1;
                map[key] = ParseValue(text, ref i);
            }
            return map;
        }

        private static List<object> ParseArray(string text, ref int i)
        {
            List<object> list = new List<object>();
            i += 1;
            while (true)
            {
                Skip(text, ref i);
                if (i >= text.Length) break;
                if (text[i] == ']') { i += 1; break; }
                if (text[i] == ',') { i += 1; continue; }
                list.Add(ParseValue(text, ref i));
            }
            return list;
        }

        private static string ParseString(string text, ref int i)
        {
            StringBuilder sb = new StringBuilder();
            i += 1;
            while (i < text.Length)
            {
                char c = text[i];
                if (c == '"') { i += 1; break; }
                if (c == '\\' && i + 1 < text.Length)
                {
                    i += 1;
                    char esc = text[i];
                    if (esc == 'n') sb.Append('\n');
                    else if (esc == 'r') sb.Append('\r');
                    else if (esc == 't') sb.Append('\t');
                    else if (esc == 'b') sb.Append('\b');
                    else if (esc == 'f') sb.Append('\f');
                    else if (esc == 'u' && i + 4 < text.Length)
                    {
                        string hex = text.Substring(i + 1, 4);
                        int code;
                        if (int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code)) sb.Append((char)code);
                        i += 4;
                    }
                    else sb.Append(esc);
                    i += 1;
                    continue;
                }
                sb.Append(c);
                i += 1;
            }
            return sb.ToString();
        }

        private static double ParseNumber(string text, ref int i)
        {
            int start = i;
            while (i < text.Length && "-+.eE0123456789".IndexOf(text[i]) >= 0) i += 1;
            double value;
            double.TryParse(text.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out value);
            return value;
        }

        private static void Skip(string text, ref int i)
        {
            while (i < text.Length && (text[i] == ' ' || text[i] == '\n' || text[i] == '\r' || text[i] == '\t')) i += 1;
        }

        public static string Quote(string text)
        {
            if (text == null) return "null";
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            foreach (char c in text)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Serialize(object value)
        {
            if (value == null) return "null";
            string text = value as string;
            if (text != null) return Quote(text);
            if (value is bool) return (bool)value ? "true" : "false";
            if (value is double)
            {
                double d = (double)value;
                if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
                return d.ToString("R", CultureInfo.InvariantCulture);
            }
            if (value is int) return ((int)value).ToString(CultureInfo.InvariantCulture);
            Dictionary<string, object> map = value as Dictionary<string, object>;
            if (map != null)
            {
                StringBuilder sb = new StringBuilder("{");
                bool first = true;
                foreach (KeyValuePair<string, object> pair in map)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(Quote(pair.Key)).Append(':').Append(Serialize(pair.Value));
                }
                sb.Append('}');
                return sb.ToString();
            }
            List<object> list = value as List<object>;
            if (list != null)
            {
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < list.Count; i += 1)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(Serialize(list[i]));
                }
                sb.Append(']');
                return sb.ToString();
            }
            List<Dictionary<string, object>> maps = value as List<Dictionary<string, object>>;
            if (maps != null)
            {
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < maps.Count; i += 1)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(Serialize(maps[i]));
                }
                sb.Append(']');
                return sb.ToString();
            }
            return Quote(value.ToString());
        }
    }

    /* ============================== 分片对拍（--selftest-segments） ============================== */

    internal static class SelfTest
    {
        public static List<TimelineStep> DefaultTimeline()
        {
            List<TimelineStep> timeline = new List<TimelineStep>();
            timeline.Add(Step(2, true));
            timeline.Add(Step(1.2, false));
            timeline.Add(Step(2, true));
            return timeline;
        }

        private static TimelineStep Step(double seconds, bool voiced)
        {
            TimelineStep step = new TimelineStep();
            step.Seconds = seconds;
            step.Voiced = voiced;
            return step;
        }

        /**
         * 无帧看门狗自测：真设备不在这里验证（自测不开设备），但
         * "多久没帧算停摆"与"收到帧后立刻恢复"这两条判定必须能被机器证伪 ——
         * 误报会掐断正常采集，漏报会让设备掉线表现成"界面卡住"。
         */
        public static string RunStall(int timeoutMs)
        {
            int ms = timeoutMs <= 0 ? 200 : timeoutMs;
            FrameWatch watch = new FrameWatch(ms);
            watch.Reset();
            bool freshBlocked = watch.Stalled;
            while (watch.IdleMs < ms + 120) Thread.Sleep(10);
            bool stalled = watch.Stalled;
            watch.Reset();
            bool afterReset = watch.Stalled;
            bool ok = !freshBlocked && stalled && !afterReset;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":").Append(ok ? "true" : "false");
            sb.Append(",\"timeoutMs\":").Append(ms);
            sb.Append(",\"freshBlocked\":").Append(freshBlocked ? "true" : "false");
            sb.Append(",\"stalled\":").Append(stalled ? "true" : "false");
            sb.Append(",\"afterReset\":").Append(afterReset ? "true" : "false");
            sb.Append('}');
            return sb.ToString();
        }

        public static string RunSegments(string timelineSpec, string configSpec)
        {
            List<TimelineStep> timeline = ParseTimeline(timelineSpec);
            SegmentConfig config = ParseConfig(configSpec);
            Assembler assembler = new Assembler(config);
            List<Dictionary<string, object>> segments = new List<Dictionary<string, object>>();
            double cursor = 0;
            const double frameSec = 0.5;
            foreach (TimelineStep step in timeline)
            {
                /* 帧长固定 0.5s（与真实采集、capture.ts 的 chunker 一致）：步长按 0.5 的倍数给 */
                int frames = Math.Max(1, (int)Math.Round(step.Seconds / frameSec));
                double frameLength = frameSec;
                for (int i = 0; i < frames; i += 1)
                {
                    Frame frame = new Frame();
                    frame.StartSec = cursor;
                    frame.EndSec = cursor + frameLength;
                    frame.Voiced = step.Voiced;
                    frame.Pcm = new byte[(int)Math.Round(frameLength * 16000) * 2];
                    cursor = frame.EndSec;
                    foreach (Chunk chunk in assembler.Feed(frame))
                    {
                        segments.Add(SegmentJson(chunk));
                    }
                }
            }
            foreach (Chunk chunk in assembler.Finish(cursor))
            {
                segments.Add(SegmentJson(chunk));
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = true;
            result["segments"] = segments;
            result["droppedShort"] = assembler.DroppedShort;
            result["elapsedSec"] = cursor;
            return Json.Serialize(result);
        }

        private static Dictionary<string, object> SegmentJson(Chunk chunk)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["index"] = chunk.Plan.Index;
            map["startSec"] = chunk.Plan.StartSec;
            map["endSec"] = chunk.Plan.EndSec;
            map["seconds"] = chunk.Plan.EndSec - chunk.Plan.StartSec;
            map["reason"] = chunk.Plan.Reason;
            map["wavBytes"] = chunk.Audio.Length;
            return map;
        }

        private static SegmentConfig ParseConfig(string spec)
        {
            SegmentConfig config = new SegmentConfig();
            if (spec.Length == 0) return config;
            string[] parts = spec.Split(',');
            if (parts.Length != 3) throw new ConfigException("--config 需要三格：silenceMs,maxSeconds,minSeconds");
            config.SilenceMs = int.Parse(parts[0], CultureInfo.InvariantCulture);
            config.MaxSeconds = int.Parse(parts[1], CultureInfo.InvariantCulture);
            config.MinSeconds = int.Parse(parts[2], CultureInfo.InvariantCulture);
            return config;
        }

        private static List<TimelineStep> ParseTimeline(string spec)
        {
            if (spec.Length == 0) return DefaultTimeline();
            List<TimelineStep> timeline = new List<TimelineStep>();
            string[] parts = spec.Split(';');
            foreach (string part in parts)
            {
                if (part.Trim().Length == 0) continue;
                string[] pair = part.Split(',');
                if (pair.Length != 2) throw new ConfigException("--timeline 形如 \"2,1;1.2,0\"");
                timeline.Add(Step(double.Parse(pair[0], CultureInfo.InvariantCulture), pair[1].Trim() == "1"));
            }
            return timeline;
        }
    }
}
