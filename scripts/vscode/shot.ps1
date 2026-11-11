# Renders only the VS Code test window itself (PrintWindow), never other windows on the screen.
param([string]$Path)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  public struct RECT { public int L, T, R, B; }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Extension Development Host*' } | Select-Object -First 1
if (-not $p) { throw 'no Extension Development Host window' }
$h = $p.MainWindowHandle
[W]::ShowWindow($h, 3) | Out-Null
Start-Sleep -Milliseconds 800
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [W]::PrintWindow($h, $dc, 2)  # PW_RENDERFULLCONTENT: Chromium windows render their own content
$g.ReleaseHdc($dc)
if (-not $ok) { throw 'PrintWindow failed' }
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
