# Capture a single window's pixels with PrintWindow (works even when it is behind others).
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param([string]$Out = "$env:TEMP\ts-printwindow.png")

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process TrendScope -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "no main window handle"; exit 1 }

$rect = New-Object Win32+RECT
[void][Win32]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Host ("visible=" + [Win32]::IsWindowVisible($hwnd) + " size=" + $w + "x" + $h)

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2: needed for DirectComposition / WebView2 surfaces
$ok = [Win32]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("PrintWindow=" + $ok + " saved=" + $Out)

# how much of the capture is non-white? a blank shell would be ~100% one colour
$chk = New-Object System.Drawing.Bitmap $Out
$distinct = @{}
for ($y = 0; $y -lt $chk.Height; $y += 37) {
  for ($x = 0; $x -lt $chk.Width; $x += 37) {
    $c = $chk.GetPixel($x, $y)
    $distinct[$("{0}-{1}-{2}" -f $c.R, $c.G, $c.B)] = 1
  }
}
$chk.Dispose()
Write-Host ("distinct sampled colours: " + $distinct.Count)
