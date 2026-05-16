# Better Auth migrations

SourceWeft uses two database migration owners in the backend:

- Better Auth owns its auth and plugin schema through the Better Auth CLI.
- Drizzle owns the application schema in `src/shared/db/schema.ts`.

Do not add Better Auth tables such as `"user"`, `session`, `account`,
`organization`, plugin tables, or plugin-owned auth columns to the Drizzle
schema. Keeping those objects under one owner avoids migration drift.

The CLI entrypoint is `src/modules/auth/auth.migration.ts`. It intentionally
declares the full Better Auth schema, including schema-bearing plugins that may
be runtime-gated in `src/modules/auth/auth.ts`. The migration entrypoint should
stay schema-focused: include schema-bearing plugins, but keep runtime email
handlers, webhook callbacks, onboarding hooks, and workspace side effects out of
migration mode.

## Commands

Run auth migrations before Drizzle migrations:

```sh
pnpm --filter @sourceweft/backend migrate:auth
pnpm --filter @sourceweft/backend db:migrate
```

`migrate:auth` uses the locally installed Better Auth CLI package, `auth`. Do
not use `pnpm dlx` for this path: the CLI version should come from
`package.json` and `pnpm-lock.yaml` together with the installed Better Auth
runtime packages.

## Plugin schema changes

Re-run auth migrations and generated schema verification after changing or
upgrading any of:

- `better-auth`
- `@better-auth/*`
- `@creem_io/better-auth`
- Better Auth plugins in `src/modules/auth/auth-config.ts`

The Creem plugin persists subscription data and extends the Better Auth `user`
model while `persistSubscriptions` is enabled. In particular, it requires:

- `"user"."creemCustomerId"`
- `"user"."hadTrial"`
- `creem_subscription`

`hadTrial` is used by the Creem plugin for trial abuse prevention.

Do not patch these fields with Drizzle migrations. If a Better Auth plugin adds
or changes auth-owned schema, update `src/modules/auth/auth.migration.ts` or the
shared factory so the Better Auth CLI sees that plugin, then run
`migrate:auth`.

## Business migrations

Drizzle migrations may depend on auth-owned tables through foreign keys, but
they should not create or alter Better Auth-owned tables, plugin tables, or
auth-owned columns. When replacing a unique index or constraint referenced by a
Drizzle-owned foreign key, the migration must explicitly drop the dependent
foreign key, replace the index or constraint, and recreate the foreign key in
the same migration.

Billing data backfills are not part of the main auth migration chain. If a
deployment needs to preserve or reshape existing billing data, add that as an
explicit, auditable compatibility migration or an operator-run backfill with its
own verification steps. Do not hide billing data rewrites inside Better Auth
schema migrations.

## Fresh rebuild

A fresh database rebuild should run auth migrations first and Drizzle
migrations second:

```sh
pnpm --filter @sourceweft/backend migrate:auth
pnpm --filter @sourceweft/backend db:migrate
```

`db:migrate` already chains `migrate:auth` before `drizzle-kit migrate`, so it
is the normal single command once the database is reachable.

Postgres must have the `pgvector` extension available to the application
database user before applying the historical Drizzle baseline, because the
baseline creates `vector`-typed columns. The explicit pgvector guard migration is
kept as an idempotent later migration for existing environments, but it cannot
run before the historical baseline.

## Verification

After auth migrations, verify the active database schema directly in Postgres
or by running an email/password sign-up flow in an environment where the Creem
runtime plugin is enabled.

```sh
pnpm --filter @sourceweft/backend auth:generate --output /tmp/sourceweft-auth-schema.sql
pnpm --filter @sourceweft/backend migrate:auth
pnpm --filter @sourceweft/backend migrate:auth
pnpm --filter @sourceweft/backend db:migrate
pnpm --filter @sourceweft/backend check-types
```

When auth schema drift exists, the generated schema should include
`"user"."creemCustomerId"`, `"user"."hadTrial"`, and `creem_subscription`
whenever Creem schema persistence is enabled in the migration config. When the
database is already current, `auth:generate` reports that the schema is up to
date; in that case, verify those columns and tables directly in Postgres. The
second `migrate:auth` run should be a no-op.
