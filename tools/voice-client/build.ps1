# Build the standalone Windows voice-capture client.
# Uses the built-in .NET Framework csc.exe (offline, no NuGet).
# Output: tools/voice-client/bin/VoiceCaptureClient.exe

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  throw "csc.exe not found: $csc (requires .NET Framework 4.x)"
}

$bin = Join-Path $here 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$target = Join-Path $bin 'VoiceCaptureClient.exe'
$sources = @(
  (Join-Path $here 'VoiceCaptureClient.cs'),
  (Join-Path $here 'VoiceClientSettings.cs'),
  (Join-Path $here 'VoiceClientTray.cs')
)
$icon = Join-Path $here 'app.ico'

# Generate the icon on first build (or when it is missing); it is embedded as a Win32 resource.
if (-not (Test-Path $icon)) {
  & (Join-Path $here 'make-icon.ps1')
}

# /target:exe（不是 winexe）：自测与运维都靠 stdout；托盘模式自己隐藏控制台并转写日志文件。
# System.Windows.Forms / System.Drawing 只给托盘与设备窗口用，采集链路不依赖它们。
& $csc /nologo /codepage:65001 /target:exe /platform:anycpu /optimize+ /win32icon:"$icon" /out:"$target" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll $sources
if ($LASTEXITCODE -ne 0) {
  throw "build failed (csc exit $LASTEXITCODE)"
}

$size = (Get-Item $target).Length
Write-Host ("built: {0} ({1:N0} bytes)" -f $target, $size)
