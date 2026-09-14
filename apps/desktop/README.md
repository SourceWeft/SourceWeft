# Desktop (Tauri)

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

This directory hosts the desktop application.

- `src/`: frontend entry and desktop web UI wiring
- `src/lib/sdk.ts`: shared SDK bootstrap placeholder for desktop frontend
- `src-tauri/`: Rust runtime and Tauri configuration

Desktop frontend should reuse `packages/ui` (`@sourceweft/ui-web`) and `packages/sdk`.

Environment template: `apps/desktop/.env.example`.

For PC working directories, file panels, directory selection, and upgrade instructions, see [LOCAL_FILES.md](./LOCAL_FILES.md).
