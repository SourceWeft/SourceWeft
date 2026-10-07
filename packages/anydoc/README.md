# Maintained AnyDoc native binding

This package preserves the AnyDoc 0.2.4 Node API and conversion implementation from official tag `v0.2.4` (commit `42bf1c5ecdde9eb0d96d6bd75a9e6698cf93b14c`). Upstream MIT licensing is retained. `UPSTREAM.json` records original source checksums; `upstream/Cargo.lock` pins the native dependency graph, including pdf-inspector 1.14.2.

The only conversion patch is in `upstream/src/formats/pdf.rs`: configure `remove_page_numbers=false`. The upstream isolated-line heuristic deletes legitimate standalone quantities such as `39`. Preservation also retains genuine numeric page footers; this is an explicit content-preservation tradeoff, not a parser/provider or OCR change. Scanned documents still reject OCR through the existing caller policy.

Run `pnpm --filter @sourceweft/anydoc native:build` with Rust before native tests. The build produces `native/bindings.node` and `native/build.json` with a SHA-256 receipt. Runtime requires that maintained binary and fails if it is unavailable; it never downloads, compiles or loads an unpatched upstream binary. Build native artifacts for the deployment platform before packaging. Keep Rust sources, test fixtures and build outputs outside final runtime layers; ship JavaScript, declarations, native binding, receipt and MIT license.

Run `pnpm --filter @sourceweft/anydoc test` for the real NAPI regression tests. The original PDF bytes are retained unchanged. The document-parser package additionally verifies parsed content/chunks and all previously supported formats.
