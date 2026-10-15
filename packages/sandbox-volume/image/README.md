# Helper image reliability contract

`helper/build.sh` builds `swvol`, `swlazy`, and `swvol-supervisor` with the original
musl-cross builder images and strictly checks their original toolchains: x86_64 uses
Rust 1.96.1 and aarch64 uses Rust 1.95.0. The versions differ in the original pinned
images; builds retain native-host image selection without installing another toolchain
or switching execution platform. Receipts record the exact per-architecture version.
Fetch the locked dependencies explicitly before building (the reliability CI does this).
The build uses `cargo build --locked --offline`, removes
old selected output before compilation, checks that sources do not change during the build,
and propagates compilation failures. A successful
artifact has an architecture/target/source/builder/binary receipt and a SHA-256 sidecar.
`VERSION` is emitted only after all selected helpers succeed. Select `SWVOL_ARCHES` as
`x86_64`, `aarch64`, or `x86_64,aarch64`; no other value implicitly selects a target.
`SWVOL_HELPERS` optionally selects a comma-separated subset of those three helpers for
an explicit partial rebuild. Such a subset is not a complete installable bundle.

The image packaging step must stage all three helpers, their `.receipt.json` and `.sha256`
files, `VERSION`, and `swvol-init` next to `install-swvol.sh`. The installer validates
crate, architecture, target, binary hash, and reported bundle version before changing the image.
It retains receipts in `/usr/local/share/swvol`. These scripts are not yet an integrated
provider image publication pipeline or proof of protected daemon supervision.

`swvol-init` is a root-only fixed image boot step. It requires the installed identity,
helper, FUSE device/configuration and a nonempty plan. Compressed plans are installed
atomically; decompression failure leaves no partially installed plan. Both FUSE lower
and workspace overlay must actually be mounted before successful completion. Overlay
failure exits nonzero; the previous implicit tmpfs upper is removed. An explicitly
configured `SWVOL_UPPER_BASE` must exist. Privilege lowering and provider entrypoint
wiring remain the image integration's responsibility; no user-run failure counts as
successful boot.

Run the hermetic failure regressions with:

```sh
python3 packages/sandbox-volume/tests/scripts/reliability.test.py
bash -n packages/sandbox-volume/helper/build.sh
sh -n packages/sandbox-volume/image/install-swvol.sh
sh -n packages/sandbox-volume/image/swvol-init
```

These tests replace devices/mounts/root paths in temporary copies and mock privileged
operations. They verify shell failure semantics, not actual FUSE, overlay, provider
boot or tenant isolation. Those need separate real provider image acceptance.
