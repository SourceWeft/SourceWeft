# Release verification

The tag release workflow validates the version tag and runs the reusable CI
including real self-hosting Compose acceptance before publishing the universal
container image. Web releases do not depend on desktop version numbers or builds. Reusable workflows run from the same commit as
the tagged workflow; see [GitHub's reusable workflow documentation](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

Before creating a `vMAJOR.MINOR.PATCH` tag (optionally with a semver prerelease):

- Configure public Web/API URLs at runtime in the installation's `.env`, not in
  repository build variables. The same image supports different installations.
- Before a separate desktop distribution, match the version in
  `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- Keep prereleases on their full version tags. Only stable tags update the image's
  minor alias and `latest`; prereleases are marked as such in GitHub Releases.
- Use the default PostgreSQL image
  `ghcr.io/sourceweft/sourceweft-postgres:17`, or explicitly pin
  `SOURCEWEFT_POSTGRES_IMAGE` to the intended published version/digest.

## Desktop installers

The current macOS candidate is `0.2.0-rc.1`. Preparation status and local
verification artifacts are tracked in
[`releases/v0.2.0-rc.1-macos.md`](../../releases/v0.2.0-rc.1-macos.md).

`.github/workflows/desktop-build.yml` is reusable, manually dispatchable, and runs
for desktop changes in pull requests. It builds a macOS app/DMG and Windows NSIS
installer with the committed lockfile, then retains them as workflow artifacts.
It does not install the app or publish these artifacts as customer downloads.
CI explicitly uses `--no-sign` and verifies the macOS disk image with
`hdiutil verify`. Its macOS runner does not depend on the developer's local
screen being unlocked. Run it with `gh workflow run desktop-build.yml --ref main`
after committing the candidate version; this does not create a release tag.

Local macOS packaging:

```sh
pnpm --filter @sourceweft/desktop exec tauri build --ci --bundles app,dmg -- --locked
```

These verification artifacts are not evidence of Developer ID signing,
notarization, Windows publisher signing, or successful clean installation.
Before public desktop distribution, configure the actual signing identities and
credentials in the release environment and perform the platform checks described
in [Tauri's distribution guide](https://v2.tauri.app/distribute/). Credentials and
production addresses are not generated or guessed by this repository.

The release application currently opens `https://sourceweft.com` unless its
runtime environment explicitly provides `NEXT_PUBLIC_WEB_BASE_URL`. Confirm that
this service supports the packaged native protocol, sign-in/deep links, local
files and permission prompts. An installer build alone does not verify those
production flows.
