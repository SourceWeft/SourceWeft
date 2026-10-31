# macOS local capabilities — foundation checkpoint (3fd84bfd)

This file records the earlier foundation commit. The current in-progress device
gateway, immutable conversation targets, and real test results are described in
`E2E_REPORT.md`; statements below about unavailable dispatch refer to that earlier
checkpoint, not the current working tree.

This file describes the macOS foundation only. Linux local execution (bubblewrap-based
sandbox, `.deb` and AppImage setup, the runtime download, toolchain access) is documented
in [LINUX_SANDBOX.md](./LINUX_SANDBOX.md).

The desktop client continues to load the existing Web URL and reuse the existing
chat/settings UI. There is no separate desktop homepage or native settings page.
Windows local execution (a separate-account sandbox with a one-time administrator setup) is
documented in [WINDOWS_SANDBOX.md](./WINDOWS_SANDBOX.md).

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
- Sandboxed command execution on macOS and Linux through the `sandbox-sidecar`
  bundle (`srt-sidecar`, built on sandbox-runtime: Seatbelt on macOS, bubblewrap on
  Linux). Readiness is the bundle's `init` + `probe` round trip. Real-host suites
  cover filesystem, subprocess, symlink, and network isolation.

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

The real macOS sandbox suite is opt-in (every test is `#[ignore]`) because an outer
sandbox may prohibit `sandbox_apply`, and it needs the built sidecar bundle. Run it
on a real, unrestricted macOS host; do not silently replace it with an unconfined
execution test. Build the bundle first (Bun 1.4.2), then run the suite:

```sh
(cd apps/desktop/sandbox-sidecar && bun run build --rg "$(command -v rg)")
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test macos_sandbox -- --include-ignored --test-threads=1
```

The same bundle also backs the other opt-in real tests (`--test macos_signing`,
`--test local_execution`, `--test local_workspaces`, `--test local_binary_reads`), run with the same
`-- --include-ignored --test-threads=1` flags.

`hostname_to_loopback_blocked` also needs these `/etc/hosts` entries and fails with
that instruction when they are missing:

```
127.0.0.1 sw-loop.test
10.0.0.1 sw-private.test
```

`public_https_allowed` makes a real request to the public npm registry, so the host
needs working public internet. The ordinary `cargo test --lib` run covers the Rust
units without the bundle. Passing the suite is not completion of P0: cancellation,
identity and durable Agent resume still require validation before enabling local
Agent execution.
