# macOS local capabilities — foundation checkpoint (3fd84bfd)

This file records the earlier foundation commit. The current in-progress device
gateway, immutable conversation targets, and real test results are described in
`E2E_REPORT.md`; statements below about unavailable dispatch refer to that earlier
checkpoint, not the current working tree.

The desktop client continues to load the existing Web URL and reuse the existing
chat/settings UI. There is no separate desktop homepage or native settings page.
Windows implementation is deferred.

## Implemented foundation

- A Rust `LocalHost` managed by the Tauri application independently of the WebView.
- SQLite-backed automatic workspace allocation, scoped by authenticated caller
  identity and thread (the authenticated caller integration is still pending).
- Lazy allocation, durable reservation, restart reuse, concurrent-call deduplication,
  ownership markers, and filesystem device/inode checks. Missing or replaced
  ready directories are not silently recreated; unknown directories are not adopted.
- Descriptor-relative UTF-8 file reads that reject traversal, symlinks, hardlinks,
  special files, and oversized input. File writes/backups are not implemented yet.
- A narrow `local_host_status` command consumed through the existing Web
  `desktopBridge`, with window/origin checks and Tauri command permissions.
- A P0 Seatbelt probe and real macOS tests of filesystem, subprocess, symlink,
  and network isolation. Its **explicit block-all network profile is a test
  fixture**, not the eventual WorkBuddy-style controlled-network default.

## Not available to users yet

Workspace allocation and file access are internal Rust services, not generic
renderer commands. `authenticatedDispatchAvailable` remains false. The chat submit
flow has not been connected, so sending a message does not yet allocate a workspace.
No arbitrary command execution or account/path supplied by a WebView is accepted.

Remaining milestones: native account/device identity; per-thread execution target;
authenticated device dispatch; first-message provisioning; command lifecycle and
controlled egress; managed file writes/backup; cross-device approvals/cancellation
and recovery; then browser and desktop control. Existing Web settings will expose
PC-specific configuration only after the associated native permissions are wired.

## Validation

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter web check-types
```

The physical Seatbelt test is opt-in because an outer sandbox may prohibit
`sandbox_apply`. Run it on a real macOS host; do not silently replace it with an
unconfined execution test:

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test macos_sandbox -- --include-ignored
```

The foundation currently has ten ordinary tests; the separate real Seatbelt run
adds the physical isolation test. Passing this probe is not completion of P0:
runtime toolchain coverage, cancellation, proxy policy, identity and durable Agent
resume still require validation before enabling local Agent execution.
