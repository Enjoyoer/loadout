# Precondition probe for a Windows daily-use PC: the interactive user has been idle long enough, no full-screen app
# is in front and no game from the configured inventory runs. Without an inventory, or with a malformed one, it
# fails closed: an unconfigured guard is not a guard. Prints one JSON line {"ok", "observed_at", "detail"}; the runner fails closed on
# anything else. Run it only from a task that runs in the user's interactive session: a session-0 or
# noninteractive task cannot see input or windows, so it reports ok=false.
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File interactive-idle.ps1 -MinIdleMinutes 15 -Games a.exe,b.exe
param(
    [ValidateRange(1, 1440)][int]$MinIdleMinutes = 15,
    [string[]]$Games = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Out-Reading([bool]$Ok, [string]$Detail) {
    $at = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    [Console]::Out.WriteLine((@{ ok = $Ok; observed_at = $at; detail = $Detail } | ConvertTo-Json -Compress))
    exit 0
}

try {
    # -File passes "a.exe,b.exe" as one string.
    $inventory = @($Games | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if (-not $inventory.Count) { Out-Reading $false 'no game inventory configured' }
    if (@($inventory | Where-Object { $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}\.exe$' }).Count) { Out-Reading $false 'game inventory malformed' }
    $session = (Get-Process -Id $PID).SessionId
    if ($session -eq 0 -or -not [Environment]::UserInteractive) { Out-Reading $false 'not in an interactive session' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AutoUpdateIdle {
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static long IdleMs() {
        var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
        if (!GetLastInputInfo(ref i)) return -1;
        return (long)unchecked((uint)Environment.TickCount - i.dwTime);
    }
    // 1 full-screen, 0 not, -1 unknown
    public static int FullScreen(out uint pid) {
        pid = 0;
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return -1;
        if (h == GetShellWindow() || h == GetDesktopWindow()) return 0;
        GetWindowThreadProcessId(h, out pid);
        RECT r; if (!GetWindowRect(h, out r)) return -1;
        var m = new MONITORINFO(); m.cbSize = (uint)Marshal.SizeOf(m);
        if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) return -1;
        return (r.Left <= m.rcMonitor.Left && r.Top <= m.rcMonitor.Top && r.Right >= m.rcMonitor.Right && r.Bottom >= m.rcMonitor.Bottom) ? 1 : 0;
    }
}
'@
    $idle = [AutoUpdateIdle]::IdleMs()
    if ($idle -lt 0) { Out-Reading $false 'idle time unavailable' }
    if ($idle -lt $MinIdleMinutes * 60000) { Out-Reading $false ("idle {0} min" -f [int]($idle / 60000)) }
    [uint32]$fgPid = 0
    $fs = [AutoUpdateIdle]::FullScreen([ref]$fgPid)
    if ($fs -lt 0) { Out-Reading $false 'foreground window unavailable' }
    if ($fs -eq 1) { Out-Reading $false 'full-screen app in front' }
    $running = @(Get-Process | Where-Object { $inventory -contains ($_.ProcessName + '.exe') })
    if ($running.Count) { Out-Reading $false 'game process running' }
    Out-Reading $true ("idle {0} min" -f [int]($idle / 60000))
} catch {
    Out-Reading $false 'probe error'
}
