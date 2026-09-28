# Pake CLI Notes

Source: https://github.com/tw93/Pake and docs in `tw93/Pake`.

## Current Baseline

- Pake turns a web page or local HTML file into a Tauri desktop app.
- Latest release observed on GitHub: V3.11.10, June 18, 2026.
- Install CLI with `pnpm install -g pake-cli`; npm is an alternative.
- Node.js 22+ is recommended. Node.js 18+ may work.
- Rust 1.85+ is required. Pake may prompt to install Rust if missing.

## High-Value Options

```text
--name                     app name
--icon                     local/remote icon, auto-converted per platform
--width / --height          initial window size
--min-width / --min-height  minimum resize bounds
--zoom                     initial zoom, 50-200
--hide-title-bar            immersive title bar, macOS only
--fullscreen / --maximize   initial window state
--activation-shortcut       global activation shortcut
--always-on-top             keep window above others
--show-system-tray          enable tray icon
--system-tray-icon          tray icon path
--hide-on-close             hide instead of close
--start-to-tray             start minimized to tray
--incognito                 private webview mode
--wasm                      enable cross-origin isolation headers for WASM
--enable-drag-drop          native drag/drop support
--keep-binary               keep standalone executable alongside installer
--iterative-build           rapid app-only debugging build
--multi-instance            allow multiple app processes
--multi-window              allow extra windows in one app instance
--new-window                allow popup/new-window flows
--force-internal-navigation keep clicked links inside the app
--internal-url-regex        regex for which links stay internal
--user-agent                custom user agent
--proxy-url                 proxy for network requests
--ignore-certificate-errors skip TLS validation for trusted dev/intranet targets
--use-local-file            recursively copy local file assets
--inject                    inject CSS/JS files
--targets                   platform architecture or package target
--debug                     enable developer tools/logging
```

## Platform Notes

Windows requires Tauri prerequisites, commonly Visual Studio Build Tools 2022, Windows 10 SDK 10.0.19041.0+, and required C++ redistributables/components. ARM64 Windows builds need ARM64 C++ build tools.

macOS can use `PAKE_CREATE_APP=1` to create `.app` bundles for testing. Use `--install` to copy directly to `/Applications`.

Linux packaging may require WebKitGTK, GTK, AppIndicator, OpenSSL, build tools, `curl`, `wget`, `file`, and other Tauri packages. AppImage builds in Docker may require FUSE and privileged options.

## Examples

```powershell
pake "https://github.com" --name "GitHub"
pake "https://weekly.tw93.fun" --name "Weekly" --icon "https://cdn.tw93.fun/pake/weekly.icns" --width 1200 --height 800 --hide-title-bar
pake ".\my-app\index.html" --name "My App" --use-local-file
pake "https://chat.example.com" --name "Chat" --show-system-tray --hide-on-close --new-window
pake "https://flutter.example.com" --name "FlutterApp" --wasm
```
