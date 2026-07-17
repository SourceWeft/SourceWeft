# src

Purpose of this directory:

- Hold mobile frontend source code.
- Provide the Tauri webview entry point when the mobile shell gets a local UI bundle.
- Expose the native bridge types used by the web app (`native-bridge.ts`).

API traffic still goes through the loaded web app (`NEXT_PUBLIC_API_BASE_URL`).
Do not add a shell-local SDK client here unless the mobile package gains its own
bundled UI that calls the backend directly.
