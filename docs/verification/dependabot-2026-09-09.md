# Dependency security patches — 2026-09-09

## Scope

| Package | Before | Patched version |
| --- | --- | --- |
| Next.js and matching Next packages | 16.3.0 | 16.3.3 |
| sharp | 0.35.3 | 0.35.4 (libheif 1.23.2) |
| js-yaml 4.x | 4.3.1 | 4.3.2 |
| Hono | 4.13.2 | 4.13.5 |
| Vitest, coverage and mocker components | 4.1.7 | 4.1.11 |

Both the core lockfile and the commercial edition lockfile use these patches. A Next override also covers automatically installed authentication peer dependencies. The existing js-yaml 5.2.3 dependency and commercial Creem SDK 1.6.0 are preserved. Sandbox global sharp is pinned to 0.35.4.

Upstream advisories: [Next AVIF](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4), [Next Windows](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), [sharp/libheif](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c), [YAML merge budget](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh), [Hono fixes](https://github.com/honojs/hono/releases/tag/v4.13.5), [Vitest mocker](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).

## Runtime behavior and regression checks

Next 16.3.3 bypasses optimization of AVIF input as its upstream mitigation; these images are returned unchanged. PNG/WebP optimization remains operational. The backend still converts uploaded AVIF to PNG with the patched decoder. Rebuilding and deploying application and sandbox images is necessary to update already running deployments.

`scripts/ci/verify-security-patches.mjs` checks actual installed versions and the native libheif version, exercises real AVIF decoding, Next AVIF bypass and PNG resizing, YAML empty-merge work limits, and Hono fragment-query and nested-form boundaries. Ordinary YAML merges and ordinary form fields remain supported. The prior dependency security regression script remains enabled.

The YAML and query tests were also checked against the existing pre-upgrade installation: it accepted over-budget empty merges and exposed query fields after a URL fragment. The patched libraries reject or exclude those inputs.

The backend image-normalizer suite covers real AVIF-to-PNG conversion, PNG passthrough and invalid AVIF rejection. Sandbox CI checks its global sharp/libheif versions and real decoding inside each non-root image.

## Local verification

- Frozen installation and source boundaries: core and commercial passed.
- npm registry audits: zero reported vulnerabilities for both editions, including development dependencies (no `--prod` filter).
- Existing and new security regression scripts: passed in both editions.
- Full workspace tests: 32 tasks passed; backend 1,885 passed / 2 existing skips, Web 580 passed.
- Commercial unit tests: 70 passed.
- Lint: passed. Full workspace type checks: 40 tasks passed. Commercial billing/backend/Web type checks: passed.
- Core Web, Docs and backend builds: passed. Commercial Web/backend builds: passed.
- Source preparation tests: 6 passed.

The PR's CI results provide remote Node 22/24, edition E2E and actual Docker/sandbox image verification. Local checks do not claim an exploit test against a Windows server, an unsafe native-code proof of concept, or a production deployment. CI now runs `pnpm audit --audit-level=moderate` for core and commercial source trees; a new advisory or an unavailable audit service fails the audit instead of silently skipping it.
