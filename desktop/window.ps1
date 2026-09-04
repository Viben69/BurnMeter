<#
  Window control for the BurnMeter gauge.

  A web page can't reliably move, resize or raise its own OS window — browsers
  block window.resizeTo in some window types and never allow always-on-top. So
  the page asks the server, and the server runs this.

  It only ever touches top-level windows whose title matches -Title AND whose
  owning process is the browser hosting the gauge.

    -Action top      keep the window above every other window
    -Action untop    release it
    -Action size     resize to -Width x -Height (keeps position)
    -Action corner   park it in -Corner (TL/TR/BL/BR) of its current monitor
    -Action move     put its top-left at -X,-Y (keeps size)
    -Action raise     bring it to the front (and restore it if minimised)
    -Action state    report current size, position and topmost flag

  Prints "ok <n>" on success, "not-found" when no matching window is open.
#>
param(
  [string]$Title = 'BurnMeter Gauge',
  [ValidateSet('top','untop','size','corner','move','raise','state')][string]$Action = 'state',
  [switch]$Exact,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Width = 380,
  [int]$Height = 196,
  [ValidateSet('TL','TR','BL','BR')][string]$Corner = 'BR',
  [int]$Margin = 12
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class BurnMeterWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int  GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(
      IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);

  public static List<IntPtr> Find(string needle, string[] procNames) { return Find(needle, procNames, false); }
  public static List<IntPtr> Find(string needle, string[] procNames, bool exact) {
    var hits = new List<IntPtr>();
    var wanted = new HashSet<int>();
    foreach (string n in procNames) {
      try { foreach (var p in System.Diagnostics.Process.GetProcessesByName(n)) wanted.Add(p.Id); }
      catch { }
    }
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      string title = sb.ToString();
      if (exact ? !title.Equals(needle, StringComparison.OrdinalIgnoreCase)
                : title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (wanted.Count > 0 && !wanted.Contains((int)pid)) return true;   // browser windows only
      hits.Add(h);
      return true;
    }, IntPtr.Zero);
    return hits;
  }
}
'@

$TOPMOST   = New-Object System.IntPtr -ArgumentList (-1)
$NOTOPMOST = New-Object System.IntPtr -ArgumentList (-2)
$SWP_NOSIZE = 0x0001; $SWP_NOMOVE = 0x0002; $SWP_NOACTIVATE = 0x0010
$SWP_NOZORDER = 0x0004
$GWL_EXSTYLE = -20; $WS_EX_TOPMOST = 0x8

$windows = [BurnMeterWin]::Find($Title, @('msedge','chrome','brave','vivaldi'), [bool]$Exact)
if ($windows.Count -eq 0) { Write-Output 'not-found'; exit 1 }

foreach ($h in $windows) {
  switch ($Action) {

    'top'   { [void][BurnMeterWin]::SetWindowPos($h, $TOPMOST,   0,0,0,0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)) }
    'untop' { [void][BurnMeterWin]::SetWindowPos($h, $NOTOPMOST, 0,0,0,0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)) }

    'size' {
      $r = New-Object BurnMeterWin+RECT
      [void][BurnMeterWin]::GetWindowRect($h, [ref]$r)
      # Keep the window fully on its monitor after growing. Chromium refuses a
      # programmatic size that does not fit the work area - and falls back to
      # an arbitrary one - so clamp the request to what can actually be granted.
      $scr = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
      $Width  = [Math]::Min($Width,  $scr.Width  - $Margin)
      $Height = [Math]::Min($Height, $scr.Height - $Margin)
      $x = [Math]::Min($r.L, $scr.Right  - $Width  - $Margin)
      $y = [Math]::Min($r.T, $scr.Bottom - $Height - $Margin)
      $x = [Math]::Max($x, $scr.Left); $y = [Math]::Max($y, $scr.Top)
      [void][BurnMeterWin]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $Width, $Height, ($SWP_NOZORDER -bor $SWP_NOACTIVATE))
    }

    'corner' {
      $r = New-Object BurnMeterWin+RECT
      [void][BurnMeterWin]::GetWindowRect($h, [ref]$r)
      $w = $r.R - $r.L; $hh = $r.B - $r.T
      $scr = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
      switch ($Corner) {
        'TL' { $x = $scr.Left + $Margin;                 $y = $scr.Top + $Margin }
        'TR' { $x = $scr.Right - $w - $Margin;           $y = $scr.Top + $Margin }
        'BL' { $x = $scr.Left + $Margin;                 $y = $scr.Bottom - $hh - $Margin }
        default { $x = $scr.Right - $w - $Margin;        $y = $scr.Bottom - $hh - $Margin }
      }
      [void][BurnMeterWin]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE))
    }

    'move' {
      [void][BurnMeterWin]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE))
    }

    'raise' {
      if ([BurnMeterWin]::IsIconic($h)) { [void][BurnMeterWin]::ShowWindow($h, 9) }   # SW_RESTORE
      [void][BurnMeterWin]::SetForegroundWindow($h)
    }

    'state' {
      $r = New-Object BurnMeterWin+RECT
      [void][BurnMeterWin]::GetWindowRect($h, [ref]$r)
      $ex = [BurnMeterWin]::GetWindowLong($h, $GWL_EXSTYLE)
      Write-Output ("state {0}x{1} at {2},{3} topmost={4}" -f ($r.R-$r.L), ($r.B-$r.T), $r.L, $r.T, (($ex -band $WS_EX_TOPMOST) -ne 0))
    }
  }
}

if ($Action -ne 'state') { Write-Output "ok $($windows.Count)" }
