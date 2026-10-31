# Desktop (Tauri)

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

This directory hosts the desktop application.

- `src/`: frontend entry and desktop web UI wiring
- `src/lib/sdk.ts`: shared SDK bootstrap placeholder for desktop frontend
- `src-tauri/`: Rust runtime and Tauri configuration

Desktop frontend should reuse `packages/ui` (`@sourceweft/ui-web`) and `packages/sdk`.

Environment template: `apps/desktop/.env.example`.

For PC working directories, file panels, directory selection, and upgrade instructions, see [LOCAL_FILES.md](./LOCAL_FILES.md).
For Linux local execution (`.deb` and AppImage setup, the sandbox runtime download, troubleshooting, and which toolchains the sandbox can read), see [LINUX_SANDBOX.md](./LINUX_SANDBOX.md). For Windows local execution (the one-time administrator setup and how to remove it, the shell, what a command can read and reach, the Schannel limitation, troubleshooting), see [WINDOWS_SANDBOX.md](./WINDOWS_SANDBOX.md).
