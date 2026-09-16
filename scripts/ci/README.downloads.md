# Desktop download publication

The Release workflow builds desktop installers once, archives them in GitHub
Releases, and publishes the same bytes to an S3-compatible bucket. The public
website must use the bucket's public HTTPS domain rather than the S3 API endpoint.
No bucket credentials are needed by the website.

## GitHub Actions configuration

Configure repository **Variables**:

| Variable                        | SourceWeft R2 value / meaning                               |
| ------------------------------- | ----------------------------------------------------------- |
| `DOWNLOADS_S3_ENDPOINT`         | R2 account S3 endpoint, without the bucket name             |
| `DOWNLOADS_S3_BUCKET`           | `sourceweft-download`                                       |
| `DOWNLOADS_S3_REGION`           | `auto` for Cloudflare R2                                    |
| `DOWNLOADS_S3_FORCE_PATH_STYLE` | `true`; explicit `true` or `false` required                 |
| `DOWNLOADS_PUBLIC_BASE_URL`     | `https://download.sourceweft.com`                           |
| `DOWNLOADS_S3_PREFIX`           | Optional object-key prefix, empty for this dedicated bucket |

Configure repository **Secrets**:

- `DOWNLOADS_S3_ACCESS_KEY_ID`
- `DOWNLOADS_S3_SECRET_ACCESS_KEY`

Use a dedicated R2 Account API Token named `sourceweft-download-ci`, restricted to
Object Read & Write for `sourceweft-download`. Never use the application's source
file bucket or credentials. Other S3-compatible providers must support SigV4,
GetObject, PutObject, and conditional writes using If-Match and If-None-Match.
The public base URL maps to the bucket root; the script adds any configured prefix.

Missing configuration fails preflight. The publisher does not create buckets,
change access policies, set public-read ACLs, or substitute another download source.
Provision public read access through the download domain beforehand. The existing
R2 development URL can remain disabled. Server-side manifest reads and ordinary
download links do not require browser CORS configuration.

## Release layout and promotion

```text
releases/v0.2.0-rc.1/<installer>.dmg
releases/v0.2.0-rc.1/<installer>.exe
releases/v0.2.0-rc.1/manifest.json
channels/preview.json
channels/stable.json
```

The build job generates an artifact description using the actual host architecture
and installer SHA-256. Release checks that both macOS and Windows are present,
versions match the tag, filenames are unique, and all checksums match. Current
builds are unsigned/not notarized; Windows local execution is unsupported. These
facts are explicit in the manifest and must be updated when the build policy changes.

The workflow then:

1. Uploads installers to the GitHub release draft.
2. Uploads immutable objects to S3. Existing identical bytes are reusable; a
   different file at the same versioned key fails instead of overwriting it.
3. Downloads each file anonymously through the public domain and verifies its
   complete SHA-256 and size, then publishes and verifies the version manifest.
4. Publishes the completed GitHub Release.
5. Replaces exactly one channel manifest: prerelease tags use `preview`, stable
   tags use `stable`. This is the final step and uses an ETag conditional write.

All versioned objects are long-cacheable. Channel objects require revalidation;
do not configure CDN rules that override their `no-cache` headers. A website may
use a short, explicit server cache. A failed upload or public verification leaves
the existing channel untouched. A failure after GitHub publication can leave a
public GitHub release without promoting the website; rerun the failed release job
with the same installer artifacts after resolving the reported error.

Concurrent updates fail on ETag conflict rather than overwrite another publisher.
Older versions cannot move a channel backwards, even if their builds finish later.
Rebuilding an existing tag may produce different bytes; use a new version/tag for
replacement builds. There is no silent retry, version downgrade, or alternate host.

## Website integration contract

Read `channels/stable.json` or explicitly selected `channels/preview.json` from the
public domain. Each document contains `schemaVersion`, `version`, `tag`, `channel`,
`releaseNotesUrl`, and `artifacts`. Each artifact includes `platform`, `arch`,
`filename`, `size`, `sha256`, `url`, `githubUrl`, and the platform limitations.
The absence of a stable channel means no stable release has been published; do
not silently label the preview channel as stable.

This manifest describes website downloads. It is not a Tauri updater manifest;
in-app updates require the separate updater artifacts and cryptographic signatures.
This change does not implement the website download page or in-app updates.

## Verification

```sh
node --test scripts/ci/publish-downloads.test.mjs scripts/ci/verify-release-config.test.mjs
```

Tests cover artifact integrity, platform completeness, configuration validation,
public download verification, promotion ordering, channel separation, and version
ordering. Live R2 permissions and CDN reachability are checked by an actual release
run; local tests do not claim to verify cloud configuration.
