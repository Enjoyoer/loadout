---
name: pake
description: Package web pages, web apps, or local HTML into small cross-platform desktop applications with Pake/Tauri. Use when the user asks to wrap a website as a desktop app, create a Pake build command, troubleshoot Pake packaging, choose Pake CLI options, package local static files, or customize a Pake app with injected CSS/JS, icons, tray behavior, window sizing, navigation, or permissions.
---

# Pake

## Workflow

Use Pake when a web page should behave like a native desktop app without building an Electron shell.

1. Clarify the target URL or local `index.html`, app name, platform, icon preference, and whether the output should be an installer, portable binary, or fast test build.
2. Prefer the CLI path for normal builds. Use online/GitHub Actions builds when the local machine cannot satisfy Rust/Tauri prerequisites or the user wants no local setup.
3. Check prerequisites before building: Node.js 22+ recommended, Rust 1.85+, package manager available, and platform-specific Tauri requirements installed.
4. Build in a clean output folder. Keep generated installers/binaries outside source folders unless the user asks otherwise.
5. Validate by launching the app, checking login/navigation/popups/downloads, and rebuilding with focused options when behavior differs from the browser.

## Commands

Install:

```powershell
pnpm install -g pake-cli
```

Basic build:

```powershell
pake "https://example.com" --name "Example"
```

Common full build:

```powershell
pake "https://example.com" --name "Example" --width 1200 --height 800 --icon ".\icon.png" --show-system-tray --keep-binary
```

Fast debugging build:

```powershell
pake "https://example.com" --name "Example" --debug --iterative-build
```

Package local static files:

```powershell
pake ".\dist\index.html" --name "Example" --use-local-file
```

## Option Selection

Use `--width`, `--height`, `--min-width`, and `--min-height` for apps with fixed dashboard or tool layouts.

Use `--icon` for a local or remote icon. If omitted, Pake tries to fetch the site icon and convert it for the platform.

Use `--show-system-tray`, `--hide-on-close`, and `--start-to-tray` for chat, music, monitor, or background apps.

Use `--new-window`, `--multi-window`, or `--force-internal-navigation` when authentication, popups, or cross-domain links fail.

Use `--inject` with CSS/JS files for ad removal, visual cleanup, helper shortcuts, or site-specific behavior. Keep injected files small and source-controlled with the build when possible.

Use `--camera`, `--microphone`, and `--wasm` only when the target app actually needs those capabilities.

Use `--targets` when the user requests a specific output architecture or package format.

## Troubleshooting

Do not retry the same failing command repeatedly. If a build fails twice with the same class of error, research 3-5 current fixes from the upstream Pake/Tauri docs, choose the best match, then implement it.

On Windows, Tauri prerequisites are usually the blocker: Visual Studio Build Tools 2022, Windows 10 SDK, and C++ build components must be present. For ARM64 output, install the ARM64 C++ build tools.

For auth issues, first try `--new-window` or `--multi-window`; if the provider blocks embedded webviews, explain that Pake cannot bypass provider policy.

For local HTML, use `--use-local-file` so asset folders are copied recursively.

For TLS/dev-server packaging, use `--ignore-certificate-errors` only for trusted local or intranet targets.

## References

Read `references/pake-cli.md` when exact option names, platform requirements, or examples are needed.
