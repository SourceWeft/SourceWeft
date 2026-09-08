# Skill registry E2E

Real local Web/API, authentication, PostgreSQL and pinned GitHub downloads. Core APIs are not mocked and skill scripts are not executed.

## Prepare an isolated environment

1. Install the frozen lockfile; run the existing builds for `@sourceweft/market-contracts` and `@sourceweft/ui-web`.
2. In `apps/backend`, run `SKILL_TEST_ENV_SOURCE=/absolute/path/to/admin.env pnpm exec tsx scripts/prepare-skill-tests.ts`. It creates a new isolated database using the existing migration helper and writes `.env.skills-test` with random test secrets. The source database is not modified.
3. Set `NEXT_PUBLIC_API_BASE_URL=http://localhost:3311` and `NEXT_PUBLIC_WEB_BASE_URL=http://localhost:3310` in that test env. Set the same URLs and isolated DATABASE_URL in web `.env.local`.
4. Start API from backend: `DOTENV_CONFIG_PATH=.env.skills-test pnpm exec tsx src/api/main.ts`. Start Web from web: `pnpm exec next dev --port 3310`.
5. In backend run `pnpm exec tsx scripts/seed-skills-e2e.ts`, then restart the test API. This uses normal registration and configures only this test deployment's administrator allowlist. Credentials are in an ignored local file.
6. In web run `pnpm test:e2e:skills`. The suite performs normal browser login once for each user, then reuses genuine session cookies in isolated contexts; authentication and rate limiting stay enabled. Each case clears registry records in the explicitly named disposable database. Do not run other database tests against that database concurrently.

The default source is a real script-bearing Cisco fixture; it is queued by the current local rules. The authenticated test administrator publishes it for installation tests. This does not substitute for malformed or changed-content fixtures.

## Full acceptance fixtures

Set `SKILL_E2E_FIXTURES_FILE` to a local JSON file with fixed 40-character-commit GitHub tree URLs:

```json
{
  "sourceA": "<version A URL>",
  "name": "<frontmatter name>",
  "title": "<display title>",
  "versionB": "<same repository/skill with changed content at another commit>",
  "versionC": "<same skill with an inert static-review phrase>",
  "mixed": "<normal and malformed skills subtree>",
  "invalid": "<malformed-only subtree>",
  "spoof": "<inert external capability JSON sample>"
}
```

Run `SKILL_E2E_REQUIRE_ALL=1 pnpm test:e2e:skills` for acceptance. Missing required fixtures fail immediately. Partial mode labels missing cases **BLOCKED**; they must not be counted as passed. External fixture publishing needs explicit authorization and is not performed by these scripts.

## Database checks and evidence

In backend: `DOTENV_CONFIG_PATH=.env.skills-test RUN_SKILL_DB_TESTS=1 pnpm exec vitest run src/modules/skills/registry/versions.database.test.ts`. Tests refuse a database outside the isolated name prefix.

Reports are under the worktree's `output/playwright/`. Traces can contain disposable test-session data: keep them local; revoke sessions/drop the disposable database before sharing sanitized evidence. Inspect screenshots before sharing. Do not commit credentials.

## Cleanup

Stop test Web/API and connection pools, then drop only the database named in `.env.skills-test` using the authorized admin connection. Remove local test credential files. The preparation helper deliberately leaves its database available across API/E2E runs; it is not automatic cleanup. Never delete business data or external fixtures.
