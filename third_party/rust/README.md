# Rust compatibility backports

`glib-0.18.5/` is the official crates.io glib 0.18.5 source archive, retaining its MIT license. `glib-0.18.5-source.json` records the archive SHA-256, every original file digest and the reviewed patched file digest.

The sole production change backports [gtk-rs/gtk-rs-core #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), commit `05dff0ee696f9bcd8617cd48c4b812d046d440cb`, fixing RUSTSEC-2024-0429. `VariantStrIter::impl_get` passes a mutable pointer as a mutable out-argument to the variadic C function. The exact two-line patch is in `patches/`.

Both Tauri applications patch crates.io glib to this directory. Keeping the 0.18 API is required by their existing GTK dependency line; adding a separate glib 0.20 dependency would leave that vulnerable transitive dependency in place.

`tests/sourceweft_variant_iter.rs` and the standalone `Cargo.lock` are project-added regression tooling. CI verifies source provenance, runs upstream and project regressions with optimizations on native Linux, checks both application dependency graphs, and compiles the Linux applications. The application lockfiles must not retain registry glib 0.18.5.

Keep the upstream source unchanged except for reviewed patches. Do not rewrite the version to silence scanners. Version-only scanners may still flag 0.18.5; no audit ignore or GitHub dismissal is part of this backport. Remove the local patch once the parent Tauri/GTK dependency line can use an upstream fixed release, after repeating platform and release verification.
