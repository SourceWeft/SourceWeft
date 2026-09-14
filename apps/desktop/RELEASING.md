# Release verification

The tag release workflow validates the version tag and runs the reusable CI
including real self-hosting Compose acceptance before publishing the universal
container image and desktop installers. Desktop package versions must match the
release tag. Reusable workflows run from the same commit as
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

`.github/workflows/desktop-build.yml` is reusable, manually dispatchable, and runs
for desktop changes in pull requests. It builds a macOS app/DMG and Windows NSIS
installer with the committed lockfile, then retains them as workflow artifacts.
Standalone verification runs do not install the app or publish customer downloads.
The tag Release workflow calls this same builder, waits for both platforms and CI,
then attaches the DMG and NSIS EXE to GitHub Release alongside the self-hosting archive.
These candidate installers still skip distribution signing, as stated on the release page.
CI explicitly uses `--no-sign` and verifies the macOS disk image with
`hdiutil verify`. Its macOS runner does not depend on the developer's local
screen being unlocked. Run it with `gh workflow run desktop-build.yml --ref main`
after committing the candidate version; this does not create a release tag.

To exercise automatic packaging from a tag without publishing, push a
`ci-package-vMAJOR.MINOR.PATCH` tag (including a prerelease suffix when needed),
for example `ci-package-v0.2.0-rc.1`. CI checks that this tag matches the desktop
package, Tauri configuration, Cargo manifest and lockfile, then uploads installers
as Actions artifacts. This namespace does not match the publishing workflow's
`v*` trigger. A plain `v0.2.0-rc.1` tag still triggers the real Web/Docker release.

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
