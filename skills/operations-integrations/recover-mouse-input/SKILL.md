---
name: recover-mouse-input
description: "Use when Windows mouse clicks stop working, taskbar clicks flash red without activating, Alt-Tab fails, clicks work only in one app, foreground activation fails, an invisible Task Switching overlay is suspected, or the mouse cursor is invisible after a computer-use agent or its helper process was stopped or killed."
---

# Recover Mouse Input

Use read-only diagnostics first. Do not use Computer Use, synthetic clicks, or broad service shutdowns. Do not restart Explorer as a first fix; it does not clear a foreground-activation deadlock held by another app.

## Workflow

1. Confirm that the user is actively holding the left or right button before sampling `GetAsyncKeyState`; a zero sample without a held button proves nothing.
2. During a real click, compare `WindowFromPoint` with `GetForegroundWindow`. If the intended window is hit but foreground activation fails (taskbar flash / no activate), suspect a Windows input/foreground deadlock rather than the mouse or app.
3. Check `GetGUIThreadInfo` for mouse capture and inspect Explorer's `XamlExplorerHostIslandWindow` titled `Task Switching`. A hidden or disabled surface is acceptable; do not kill Explorer or ChatGPT merely because that window exists.
4. Sample `GetForegroundWindow` for a few seconds. If one process stays foreground while taskbar/Alt-Tab fail, treat that process as the lock holder. Also read `SPI_GETFOREGROUNDLOCKTIMEOUT` (`0x2000`): a live value of `2147483647` with a normal registry `HKCU\Control Panel\Desktop\ForegroundLockTimeout` (e.g. `200000`) is a strong deadlock signal; do not chase the registry alone.
5. Preferred first recovery: ask the user to press `Ctrl+Alt+Delete`, then return to the desktop. This secure-desktop transition fixed the observed deadlock when no single app was wedged on foreground. Do not claim an Explorer restart alone fixed it.
6. If CAD fails and a lock holder is identified: recover by clearing that app's foreground hold. Prefer asking the user to `Alt+F4` / quit it (keyboard often still works in the focused app), or use `AttachThreadInput` to the foreground thread then `ShowWindow`/`ShowWindowAsync` minimize (or `SetForegroundWindow` to the tray) and detach. Completion: `SetForegroundWindow` to a different top-level app succeeds *without* AttachThreadInput, and taskbar + Alt-Tab work. Do not kill Explorer for this path. Only terminate the lock-holder process if minimize/quit fails and the user approves.
7. If unresolved, replug the mouse and read PnP state. Inspect mouse class filters; standard `mouclass` is expected. Do not edit filters or configuration. Restart a specific mouse device only with explicit user approval and elevation.
8. Verify the target UI and one external app accept clicks, no GUI thread holds capture, and no enabled full-screen Task Switching hit surface remains.

## Invisible cursor after a computer-use helper died

Symptom: the cursor is gone after a computer-use agent or its helper process (for example a Swift or other native computer-use helper) was stopped or killed. Clicks may still work. The helper replaced the system cursors or hid the cursor and died without restoring them, so this is not an input deadlock.

Fix it before any Explorer restart or reboot, and without Computer Use or synthetic clicks. Confirm the helper process is gone, then reload the system cursors with `SystemParametersInfo(SPI_SETCURSORS = 0x0057, 0, NULL, 0)` from a process in the owner's interactive session. A process started over ssh runs in session 0 and has no effect there, so run the call once through a one-shot scheduled task with `/it` (interactive, as the logged-on user) and delete the task afterwards. Success: the log shows `result=True` with a nonzero session, and the owner sees the cursor.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.cache\fleet-scratch\recover-mouse-input\cursor'
if ($dir -match '\s') { throw "Scratch path must not contain spaces: $dir" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$script = Join-Path $dir 'reload-cursors.ps1'
$log = Join-Path $dir 'reload-cursors.log'
Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
@'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'reload-cursors.log'
try {
  Add-Type -Namespace Win32 -Name Cursor -MemberDefinition '[DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, System.IntPtr vparam, uint winIni);'
  $ok = [Win32.Cursor]::SystemParametersInfo(0x0057, 0, [IntPtr]::Zero, 0)
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  "session=$((Get-Process -Id $PID).SessionId) result=$ok lastError=$err" | Set-Content -LiteralPath $log
} catch { "error=$($_.Exception.Message)" | Set-Content -LiteralPath $log }
'@ | Set-Content -LiteralPath $script -Encoding UTF8

$task = 'RecoverCursorOnce'
# /st is required for /sc once; a time in the past only prints a warning, and /run starts it now.
schtasks.exe /create /tn $task /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $script" /sc once /st 23:59 /it /f
if ($LASTEXITCODE -ne 0) { throw "schtasks /create failed: $LASTEXITCODE" }
try {
  schtasks.exe /run /tn $task
  if ($LASTEXITCODE -ne 0) { throw "schtasks /run failed: $LASTEXITCODE" }
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $log) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
} finally {
  schtasks.exe /delete /tn $task /f | Out-Null
}
if (-not (Test-Path -LiteralPath $log)) { throw 'No log after 30 s: the task did not run in the interactive session' }
Get-Content -LiteralPath $log
```

Run it as the logged-on owner's account; `/it` runs the task only while that user is logged on. If the log shows `session=0`, the task did not reach the interactive session. If it shows `result=True` and the cursor is still missing, check that no copy of the helper is still running before going further.

## Known lock-holder pattern (2026-07)

Pake/Tauri desktop wraps (e.g. `ChatGPT WEB APP.exe`) can hold `GetForegroundWindow` for hours: taskbar clicks flash, Alt-Tab dies, Explorer restart does nothing, CAD may not clear it. Minimize/quit that process restores activation. Visible full-screen `TextInputHost` / "Windows Input Experience" is often a red herring when hit-tests still land on real apps.
