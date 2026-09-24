import "dotenv/config";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { database } from "@sourceweft/db";

// Operational audit only: reports historical connector ingestion billing that
// the owner-pays / skip-only-indexed fixes no longer produce. It never charges,
// re-indexes, or writes; PostgreSQL enforces read-only access for the snapshot.
//
// 1. Billing accounts whose (team, user) is not a current team member, such as
//    the synthetic "system" actor scheduled syncs used to bill.
// 2. Enabled connectors with no billable owner (their syncs now block).
// 3. Indexed connector sources with no page-consume ledger entry for their
//    current content, i.e. indexed without being billed.
const SAMPLE_LIMIT = 200;

async function main() {
  const { values } = parseArgs({
    options: {
      team: { type: "string" },
      out: { type: "string" },
    },
  });
  const team = values.team ?? null;
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const nonMemberAccounts = (
      await client.query(
        `select ba.team_id,
                ba.user_id,
                ba.pages_consumed_this_cycle,
                ba.credits_consumed_this_cycle,
                coalesce((
                  select sum(-ul.delta)
                  from usage_ledgers ul
                  where ul.team_id = ba.team_id
                    and ul.actor_user_id = ba.user_id
                    and ul.unit_type = 'page'
                    and ul.event_type = 'consume'
                ), 0)::int as lifetime_pages_consumed
         from billing_accounts ba
         where not exists (
                 select 1 from member m
                 where m."organizationId" = ba.team_id and m."userId" = ba.user_id
               )
           and ($1::text is null or ba.team_id = $1)
         order by lifetime_pages_consumed desc`,
        [team],
      )
    ).rows;

    const ownerlessConnectors = (
      await client.query(
        `select sc.id, sc.team_id, sc.workspace_id, sc.connector_type,
                sc.created_by, sc.status
         from source_connectors sc
         where sc.status <> 'disabled'
           and (
             sc.created_by is null
             or not exists (
               select 1 from member m
               where m."organizationId" = sc.team_id and m."userId" = sc.created_by
             )
           )
           and ($1::text is null or sc.team_id = $1)
         order by sc.team_id, sc.id`,
        [team],
      )
    ).rows;

    // Connector indexing settles with idempotency key
    // `connector-sync:{connectorId}:{externalId}:{contentHash}`, stored scoped
    // as `{actorUserId}:{key}`; any actor's consume for that content counts.
    const unbilledCondition = `
      from sources s
      where s.ingest_kind = 'connector'
        and s.source_type = 'connector'
        and s.status = 'indexed'
        and s.content_hash is not null
        and ($1::text is null or s.team_id = $1)
        and not exists (
          select 1 from usage_ledgers ul
          where ul.team_id = s.team_id
            and ul.unit_type = 'page'
            and ul.event_type = 'consume'
            and right(
                  ul.idempotency_key,
                  length('connector-sync:' || s.connector_id || ':' || s.external_id || ':' || s.content_hash)
                ) = 'connector-sync:' || s.connector_id || ':' || s.external_id || ':' || s.content_hash
        )`;
    const unbilledTotals = (
      await client.query(
        `select s.team_id, s.connector_id, count(*)::int as sources
         ${unbilledCondition}
         group by s.team_id, s.connector_id
         order by sources desc`,
        [team],
      )
    ).rows;
    const unbilledSample = (
      await client.query(
        `select s.id, s.team_id, s.workspace_id, s.connector_id, s.external_id,
                s.indexed_at
         ${unbilledCondition}
         order by s.indexed_at desc nulls last
         limit ${SAMPLE_LIMIT}`,
        [team],
      )
    ).rows;

    await client.query("COMMIT");

    const report = {
      generatedAt: new Date().toISOString(),
      team,
      nonMemberAccounts,
      ownerlessConnectors,
      unbilledIndexedSources: {
        total: unbilledTotals.reduce(
          (sum, row: { sources: number }) => sum + row.sources,
          0,
        ),
        byConnector: unbilledTotals,
        sample: unbilledSample,
      },
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) await writeFile(values.out, output);
    else process.stdout.write(output);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Audit failed");
    process.exitCode = 1;
  })
  .finally(() => database.end());
