# Desktop (Tauri)

This directory hosts the desktop application.

- `src/`: frontend entry and desktop web UI wiring
- `src/lib/sdk.ts`: shared SDK bootstrap placeholder for desktop frontend
- `src-tauri/`: Rust runtime and Tauri configuration

Desktop frontend should reuse `packages/ui` (`@sourceweft/ui-web`) and `packages/sdk`.

Environment template: `apps/desktop/.env.example`.

PC 工作目录、文件面板、目录选择和升级说明：[LOCAL_FILES.md](./LOCAL_FILES.md)。
