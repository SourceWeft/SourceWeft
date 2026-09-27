# Database migrations at startup

The SourceWeft image migrates the database in its entrypoint,
`docker/runtime-entrypoint.mjs`, before it runs a container's command — the
same place Dify's `entrypoint.sh` does. Every container passes through it, so
the command does not matter: `pnpm --filter @sourceweft/backend start:api`,
`node /app/apps/backend/dist/worker.js` and the default Web server all start on
a migrated database. No role or extra setting tells the image what a container
is.

## What the entrypoint does

When a database is configured (`DATABASE_URL`, or the `DB_*` fields it is
built from), the entrypoint runs `node apps/backend/dist/launch.js prepare`
before the command:

1. Take a PostgreSQL advisory lock (`src/launch/migration-lock.ts`). It is a
   session lock on its own connection, so a process that dies releases it with
   its connection. It waits up to 10 minutes for the database to accept
   connections and for the lock, then fails.
2. With `MIGRATION_ENABLED=true` (the default), run `db:migrate` — the auth
   schema, the Drizzle schema, then the browser-extension OAuth client. With
   `MIGRATION_ENABLED=false`, only compare the image's Drizzle journal with
   `drizzle.__drizzle_migrations`; any pending migration fails, naming what is
   missing.
3. Release the lock.

If that step fails, the container exits with its code and the command never
starts. Otherwise the command runs unchanged, with SIGTERM/SIGINT forwarded
and its exit code passed through. Containers that start together migrate once:
the others wait for the lock and then find nothing pending, so deployment order
does not matter. A container without a database configuration skips the step
(utility commands such as `pnpm --version`).

`MIGRATION_ENABLED` accepts only `true`, `false`, `1` or `0` (case-insensitive);
any other value fails startup. Set it to `false` when the application's
database account has no DDL rights or migrations are owned by another step;
the auth and extension steps then also run only in that step.

## Running migrations as a separate step

`pnpm --filter @sourceweft/backend migrate` (`launch.js migrate`) always
migrates, whatever `MIGRATION_ENABLED` says. Use it for a Kubernetes Job, a
release pipeline, or the Compose `migrate` service.

Outside the image — running the backend from source with `pnpm start:*` —
nothing migrates automatically: run `migrate` first, as with Dify's source
deployment. Local development (`pnpm dev`) likewise uses
`pnpm --filter @sourceweft/backend db:migrate`.

`launch.js api|worker|scheduler` only start that service; they exist so that
deployments already started that way keep working.

## Writing migrations

During a rolling upgrade, the new schema is in place while older processes are
still running, on every platform. A migration must therefore work with the
previous release's code:

- Allowed in one release: new tables, new nullable columns or columns with a
  default, relaxed constraints, new indexes.
- Split across two releases: dropping or renaming a column or table, and
  tightening a constraint. First ship code that no longer uses the old shape,
  then remove it in a later release.

Reverting to an older image does not revert the schema. Roll back by restoring
a database backup taken before the migration together with the older image.
