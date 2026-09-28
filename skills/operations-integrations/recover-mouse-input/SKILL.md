---
name: recover-mouse-input
description: Use when Windows mouse clicks stop working, taskbar clicks flash red without activating, Alt-Tab fails, clicks work only in one app, foreground activation fails, or an invisible Task Switching overlay is suspected.
---

# Recover Mouse Input

Use read-only diagnostics first. Do not use Computer Use, synthetic clicks, or broad service shutdowns. Do not restart Explorer as a first fix — it does not clear a foreground-activation deadlock held by another app.

## Workflow

1. Confirm that the user is actively holding the left or right button before sampling `GetAsyncKeyState`; a zero sample without a held button proves nothing.
2. During a real click, compare `WindowFromPoint` with `GetForegroundWindow`. If the intended window is hit but foreground activation fails (taskbar flash / no activate), suspect a Windows input/foreground deadlock rather than the mouse or app.
3. Check `GetGUIThreadInfo` for mouse capture and inspect Explorer's `XamlExplorerHostIslandWindow` titled `Task Switching`. A hidden or disabled surface is acceptable; do not kill Explorer or ChatGPT merely because that window exists.
4. Sample `GetForegroundWindow` for a few seconds. If one process stays foreground while taskbar/Alt-Tab fail, treat that process as the lock holder. Also read `SPI_GETFOREGROUNDLOCKTIMEOUT` (`0x2000`): a live value of `2147483647` with a normal registry `HKCU\Control Panel\Desktop\ForegroundLockTimeout` (e.g. `200000`) is a strong deadlock signal — do not chase the registry alone.
5. Preferred first recovery: ask the user to press `Ctrl+Alt+Delete`, then return to the desktop. This secure-desktop transition fixed the observed deadlock when no single app was wedged on foreground. Do not claim an Explorer restart alone fixed it.
6. If CAD fails and a lock holder is identified: recover by clearing that app's foreground hold — prefer asking the user to `Alt+F4` / quit it (keyboard often still works in the focused app), or use `AttachThreadInput` to the foreground thread then `ShowWindow`/`ShowWindowAsync` minimize (or `SetForegroundWindow` to the tray) and detach. Completion: `SetForegroundWindow` to a different top-level app succeeds *without* AttachThreadInput, and taskbar + Alt-Tab work. Do not kill Explorer for this path. Only terminate the lock-holder process if minimize/quit fails and the user approves.
7. If unresolved, replug the mouse and read PnP state. Inspect mouse class filters; standard `mouclass` is expected. Do not edit filters or configuration. Restart a specific mouse device only with explicit user approval and elevation.
8. Verify the target UI and one external app accept clicks, no GUI thread holds capture, and no enabled full-screen Task Switching hit surface remains.

## Known lock-holder pattern (2026-07)

Pake/Tauri desktop wraps (e.g. `ChatGPT WEB APP.exe`) can hold `GetForegroundWindow` for hours: taskbar clicks flash, Alt-Tab dies, Explorer restart does nothing, CAD may not clear it. Minimize/quit that process restores activation. Visible full-screen `TextInputHost` / "Windows Input Experience" is often a red herring when hit-tests still land on real apps.
