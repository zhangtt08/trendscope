# One-off: crop the watermark out of the generated icon and scale back to 1024.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less UTF-8
# .ps1 as ANSI, which mangles non-ASCII bytes and can break tokenization outright.
param(
  [string]$Src = "C:\Users\EDY\Documents\Qoder\2026-09-27\acbce3bb\vibe_images\trendscope-icon_1790674596548_6110590a.png",
  [string]$Dst = "C:\Users\EDY\Desktop\trendscope\desktop\icon-source.png"
)
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile($Src)
Write-Host ("source: " + $img.Width + " x " + $img.Height)

# The rounded-square glyph sits inside this box; the watermark is outside it.
$side = 680
$left = 176
$top = 170
$srcRect = [System.Drawing.Rectangle]::new($left, $top, $side, $side)
$dstRect = [System.Drawing.Rectangle]::new(0, 0, 1024, 1024)

$out = [System.Drawing.Bitmap]::new(1024, 1024)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

$dir = Split-Path -Parent $Dst
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$out.Save($Dst, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
$img.Dispose()
Write-Host ("saved: " + $Dst)
