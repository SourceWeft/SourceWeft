# SourceWeft Billing

Commercial billing application-service package. The Apache-2.0 host connects
through `@sourceweft/contracts/billing-runtime`; this is not an agent capability
and does not register with capability discovery.

## Implementation status

This is the initial extraction checkpoint. The original backend implementation
remains temporarily for differential verification. Backend callers, Web UI,
default startup and production edition bindings have **not** switched yet.
This checkpoint is not a complete core/commercial release and must not be
deployed as one. Copyright provenance and official commercial license review
remain release requirements.

Available package entry points:

- `/server`: service factory, explicit host ports and execution runtime adapter.
- `/postgres`: PostgreSQL store constructed with a caller-owned Pool.
- `/config`: billing configuration reader accepting an explicit environment.
- `/integrations/http`: billing routes accepting host authentication/access ports.
- `/integrations/auth`: runtime or schema-only Creem plugin configuration.
- `/integrations/creem`: subscription event synchronization with injected config.

The entry points do not import backend or web application source. Schema access
uses the open `@sourceweft/db/schema` export so importing the package does not
initialize the host's database singleton. PostgreSQL schemas and historical
migrations remain owned by `@sourceweft/db`.

## Development and verification

Prepare the commercial workspace using the repository's Node-only script:

```sh
node scripts/editions/prepare.mjs --edition=commercial --out=/private/tmp/sourceweft-billing-commercial
```

An existing tool-owned output must be explicitly replaced with `--replace=true`;
this deletes that generated workspace, including its installed dependencies.
Do not edit generated files as the source of truth. The source worktree is the
place for implementation edits. The source projection never copies `.env`
secrets or `node_modules`.

In the generated workspace:

```sh
pnpm install --frozen-lockfile
pnpm --filter @sourceweft/market-contracts build
pnpm --filter @sourceweft/billing check-types
pnpm --filter @sourceweft/billing test
pnpm --filter @sourceweft/billing test:database
```

The final command requires an explicitly isolated `sourceweft_billing_test*`
database with the existing Auth and Drizzle migrations applied. Unit tests use
explicit fixtures and need no backend `.env`, database or payment credentials.
Real PostgreSQL tests are separate and mandatory for the full release gate;
passing unit tests does not replace them. Payment-provider sandbox verification
is still pending.

`--refresh-lockfile=true` is only for intentional lockfile maintenance. Generate
the lockfile with pnpm in that workspace and save it to
`enterprise/billing/edition/pnpm-lock.yaml`; normal preparation and CI must use
the committed dedicated lockfile and frozen installation.

## License

See [LICENSE](LICENSE). The package's license and [enterprise LICENSE](../LICENSE)
must remain identical. Pre-existing Apache-2.0 permissions are preserved for
the applicable portions; see [Apache-2.0](LICENSES/Apache-2.0.txt). This package's
`private` flag prevents accidental npm publication and is not an authorization
mechanism.
