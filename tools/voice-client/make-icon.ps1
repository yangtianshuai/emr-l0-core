# Generate tools/voice-client/app.ico (multi-size, transparent rounded square).
# Drawn with GDI+ so it stays crisp at 16/24/32 px (a downscaled photo does not).
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'app.ico'

function New-RoundedRectPath([System.Drawing.RectangleF]$rect, [single]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

# Master canvas: 1024 px, then high-quality downscale for each icon size.
$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# 1) App tile: rounded square, blue -> cyan diagonal gradient.
$pad = 56
$tile = New-Object System.Drawing.RectangleF($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
$tilePath = New-RoundedRectPath $tile 200
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $tile,
  [System.Drawing.Color]::FromArgb(255, 30, 99, 216),
  [System.Drawing.Color]::FromArgb(255, 14, 165, 233),
  [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
)
$g.FillPath($gradient, $tilePath)

# 2) Microphone capsule (white).
$micWidth = 212
$micHeight = 340
$micX = ($size - $micWidth) / 2
$micY = 244
$micRect = New-Object System.Drawing.RectangleF($micX, $micY, $micWidth, $micHeight)
$micRadius = $micWidth / 2
$micPath = New-RoundedRectPath $micRect $micRadius
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillPath($white, $micPath)

# 3) Stand: U-shaped arc + stem + base (same white, round caps).
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 46)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$arcRect = New-Object System.Drawing.RectangleF(292, 330, 440, 420)
$g.DrawArc($pen, $arcRect, 15, 150)
$g.DrawLine($pen, 512, 742, 512, 806)
$g.DrawLine($pen, 418, 820, 606, 820)

# 4) Sound waves on the right (subtle, so 16 px still reads as "mic").
$wavePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 255, 255, 255), 26)
$wavePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$wavePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($wavePen, (New-Object System.Drawing.RectangleF(700, 340, 150, 220)), -52, 104)
$g.DrawArc($wavePen, (New-Object System.Drawing.RectangleF(656, 296, 240, 308)), -46, 92)

# 5) Recording dot (top-right): the one red accent.
$dotX = 786
$dotY = 186
$dotR = 58
$ring = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillEllipse($ring, ($dotX - $dotR - 16), ($dotY - $dotR - 16), (($dotR + 16) * 2), (($dotR + 16) * 2))
$red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 77, 79))
$g.FillEllipse($red, ($dotX - $dotR), ($dotY - $dotR), ($dotR * 2), ($dotR * 2))

$g.Dispose()

# 6) Downscale to each shell size, then encode a 32-bit BMP (DIB) icon entry.
#    BMP instead of PNG: .NET's System.Drawing.Icon and older shell paths still cannot
#    read PNG-compressed entries ("Requested range extends past the end of the array").
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = @()
foreach ($s in $sizes) {
  $small = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $sg.DrawImage($bmp, 0, 0, $s, $s)
  $sg.Dispose()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $locked = $small.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $locked.Stride
  $pixels = New-Object byte[] ($stride * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
  $small.UnlockBits($locked)
  $small.Dispose()

  # ICO stores XOR rows bottom-up, 32-bit BGRA (Format32bppArgb is already BGRA in memory).
  $xor = New-Object byte[] ($s * $s * 4)
  for ($y = 0; $y -lt $s; $y += 1) {
    [Array]::Copy($pixels, ($y * $stride), $xor, (($s - 1 - $y) * $s * 4), ($s * 4))
  }
  # AND mask: all zero (alpha channel does the transparency); rows padded to 4 bytes.
  $maskStride = [Math]::Floor(($s + 31) / 32) * 4
  $and = New-Object byte[] ($maskStride * $s)

  $info = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($info)
  $bw.Write([UInt32]40)              # biSize
  $bw.Write([Int32]$s)               # biWidth
  $bw.Write([Int32]($s * 2))         # biHeight: XOR + AND
  $bw.Write([UInt16]1)               # biPlanes
  $bw.Write([UInt16]32)              # biBitCount
  $bw.Write([UInt32]0)               # biCompression: BI_RGB
  $bw.Write([UInt32]($xor.Length + $and.Length))
  $bw.Write([Int32]0)                # biXPelsPerMeter
  $bw.Write([Int32]0)                # biYPelsPerMeter
  $bw.Write([UInt32]0)               # biClrUsed
  $bw.Write([UInt32]0)               # biClrImportant
  $bw.Write($xor)
  $bw.Write($and)
  $bw.Flush()
  $entries += [pscustomobject]@{ Size = $s; Bytes = $info.ToArray() }
  $bw.Dispose()
  $info.Dispose()
}
$bmp.Dispose()

# 7) Write ICO: ICONDIR + 16-byte entries + DIB payloads.
$offset = 6 + 16 * $entries.Count
$file = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($file)
$writer.Write([UInt16]0)        # reserved
$writer.Write([UInt16]1)        # type: icon
$writer.Write([UInt16]$entries.Count)
foreach ($entry in $entries) {
  $dim = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
  $writer.Write([byte]$dim)
  $writer.Write([byte]$dim)
  $writer.Write([byte]0)        # palette
  $writer.Write([byte]0)        # reserved
  $writer.Write([UInt16]1)      # color planes
  $writer.Write([UInt16]32)     # bits per pixel
  $writer.Write([UInt32]$entry.Bytes.Length)
  $writer.Write([UInt32]$offset)
  $offset += $entry.Bytes.Length
}
foreach ($entry in $entries) { $writer.Write($entry.Bytes) }
$writer.Flush()
[System.IO.File]::WriteAllBytes($out, $file.ToArray())
$writer.Dispose()
$file.Dispose()

Write-Host ("icon: {0} ({1:N0} bytes, {2} sizes)" -f $out, (Get-Item $out).Length, $entries.Count)
