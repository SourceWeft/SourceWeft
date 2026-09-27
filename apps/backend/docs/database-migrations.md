# Database migrations at startup

Every backend role starts through one launcher, `node dist/launch.js <role>`,
which the package scripts wrap: `start:api`, `start:worker`, `start:scheduler`
and `migrate`. Any deployment that starts the backend this way — Compose,
Kubernetes, a PaaS, or `pnpm start:*` on a host — gets the same behavior; the
launcher depends on no platform hook.

## What a role does before it starts

1. Take a PostgreSQL advisory lock (`src/launch/migration-lock.ts`). It is a
   session lock on the launcher's own connection, so a launcher that dies
   releases it with its connection. A role waits up to 10 minutes for the
   database to accept connections and for the lock, then exits non-zero.
2. With `MIGRATION_ENABLED=true` (the default), run `db:migrate` — the auth
   schema, the Drizzle schema, then the browser-extension OAuth client — in a
   child process. A failure exits non-zero and the service does not start.
   With `MIGRATION_ENABLED=false`, only compare the shipped Drizzle journal with
   `drizzle.__drizzle_migrations`; any pending migration stops the role, naming
   what is missing.
3. Release the lock and start the service as a child process, forwarding
   SIGTERM/SIGINT and passing its exit code through.

The `migrate` role always migrates, then exits. Use it as a separate step (the
Compose `migrate` service, a Kubernetes Job, a release pipeline). Roles that
start afterwards take the lock, find nothing pending and start. Instances that
start together migrate once: the others wait for the lock, then find nothing
to do. Deployment order does not matter.

`MIGRATION_ENABLED` accepts only `true`, `false`, `1` or `0` (case-insensitive);
any other value fails startup. Set it to `false` when the application's
database account has no DDL rights or migrations are owned by another process;
the auth and extension steps then also run only in that separate step.

Local development (`pnpm dev`) does not use the launcher. Run
`pnpm --filter @sourceweft/backend db:migrate` after pulling new migrations.

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
