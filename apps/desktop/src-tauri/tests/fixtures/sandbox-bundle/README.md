Fixtures for the sandbox runtime installer tests (`src/local_host/bundle_install.rs`).

The signing keys are THROWAWAY keys generated for these fixtures with `tauri signer generate`; their private halves were discarded and they have nothing to do with the real updater key. Only public keys are committed.

- `sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz`: a tiny fake bundle (four stand-in files plus `manifest.json`, appVersion `0.0.0-fixture`, protocolVersion 1) packed with `node scripts/ci/sandbox-bundle.mjs pack`.
- `….tar.gz.sig`: `tauri signer sign` output (`node scripts/ci/sandbox-bundle.mjs sign`) made with the first throwaway key.
- `throwaway-signer.pub`: that key's public half, in the single-line base64 form the app embeds as `SOURCEWEFT_UPDATER_PUBLIC_KEY`.
- `other-throwaway-signer.pub`: a second, unrelated throwaway public key, for the wrong-key test.

To regenerate, repeat those steps with new keys; the tests do not depend on the signature timestamp.
