# Desktop (Tauri)

This directory hosts the desktop application.

- `src/`: frontend entry and desktop web UI wiring
- `src/lib/sdk.ts`: shared SDK bootstrap placeholder for desktop frontend
- `src-tauri/`: Rust runtime and Tauri configuration

Desktop frontend should reuse `packages/ui` (`@sourceweft/ui-web`), `packages/sdk`, and `packages/domain`.

Environment template: `apps/desktop/.env.example`.
