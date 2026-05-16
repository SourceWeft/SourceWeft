# Mobile (Tauri)

This directory hosts the SourceWeft mobile shell built with Tauri 2.

- `src/`: mobile frontend bootstrap placeholders
- `src-tauri/`: Rust runtime and Tauri mobile configuration
- `placeholder-dist/`: static fallback used when a bundled frontend has not been wired yet

The app opens the shared web dashboard at `http://localhost:3000/dashboard` during development. For native projects, run the Tauri mobile init commands from this package after installing the Android and/or iOS toolchains:

The mobile host identifies itself through the same native bridge shape as the desktop host: `window.__SOURCEWEFT_NATIVE__`. Check `bridge.kind === "mobile"` or a named capability such as `externalUrl`; avoid branching on browser platform strings for native behavior.

```sh
pnpm --filter @sourceweft/mobile tauri android init
pnpm --filter @sourceweft/mobile tauri ios init
```

Then use:

```sh
pnpm --filter @sourceweft/mobile android
pnpm --filter @sourceweft/mobile ios
```
