# Release verification

The tag release workflow validates production URLs and version numbers, runs the
reusable CI workflow, and waits for macOS/Windows package verification before
publishing the container image. Reusable workflows run from the same commit as
the tagged workflow; see [GitHub's reusable workflow documentation](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

Before creating a `vMAJOR.MINOR.PATCH` tag (optionally with a semver prerelease):

- Set repository variables `NEXT_PUBLIC_API_BASE_URL` and
  `NEXT_PUBLIC_WEB_BASE_URL` to the actual production HTTPS base URLs. Missing or
  local URLs fail preflight. These values are compiled into the Web bundle.
- Match the tag version in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- Keep prereleases on their full version tags. Only stable tags update the image's
  minor alias and `latest`; prereleases are marked as such in GitHub Releases.
- Use the default PostgreSQL image
  `ghcr.io/sourceweft/sourceweft/sourceweft-postgres:17`, or explicitly pin
  `SOURCEWEFT_POSTGRES_IMAGE` to the intended published version/digest.

## Desktop installers

`.github/workflows/desktop-build.yml` is reusable, manually dispatchable, and runs
for desktop changes in pull requests. It builds a macOS app/DMG and Windows NSIS
installer with the committed lockfile, then retains them as workflow artifacts.
It does not install the app or publish these artifacts as customer downloads.

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
