import "dotenv/config";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { database } from "@sourceweft/db";
import { scopeMemberLedgerKey } from "@sourceweft/billing/ledger";
import type { MeteredModelCallTrace } from "../shared/model-gateway/billing/context";

// Operational audit only. Never calls a model, settlement, pricing, or an
// UPDATE. PostgreSQL enforces read-only access for the entire snapshot.
async function main() {
  const { values } = parseArgs({
    options: {
      team: { type: "string" },
      workspace: { type: "string" },
      run: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  if (!values.team || !values.workspace || !values.run?.length) {
    throw new Error(
      "Usage: audit-chat-metering --team ID --workspace ID --run ID [--run ID] [--out PATH]",
    );
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const reports = [];
    for (const id of new Set(values.run)) {
      const run = (
        await client.query(
          "select id,team_id,workspace_id,thread_id,user_id,assistant_message_id,status,snapshot_json from chat_thread_runs where id=$1 and team_id=$2 and workspace_id=$3",
          [id, values.team, values.workspace],
        )
      ).rows[0];
      if (!run)
        throw new Error(`Run ${id} was not found in the requested scope`);
      const message = (
        await client.query(
          "select id,credits_consumed,metadata from messages where id=$1 and team_id=$2 and workspace_id=$3 and thread_id=$4",
          [
            run.assistant_message_id,
            values.team,
            values.workspace,
            run.thread_id,
          ],
        )
      ).rows[0];
      const snapshot = run.snapshot_json ?? {};
      const metadata = message?.metadata ?? {};
      const snapshotMetadata = snapshot.assistantMessage?.metadata ?? {};
      const belongsToRun = metadata.threadRun?.id === id;
      const calls = Array.isArray(metadata.meteredLlmCalls)
        ? (metadata.meteredLlmCalls as MeteredModelCallTrace[])
        : null;
      const traceId =
        snapshotMetadata.threadRun?.id === id &&
        typeof snapshotMetadata.traceId === "string"
          ? snapshotMetadata.traceId
          : belongsToRun && typeof metadata.traceId === "string"
            ? metadata.traceId
            : null;
      const recordedPayers = new Set(
        (belongsToRun ? (calls ?? []) : [])
          .map((call) => call.billing?.teamId)
          .filter((value): value is string => typeof value === "string"),
      );
      const payer =
        typeof snapshot.billing?.teamId === "string"
          ? snapshot.billing.teamId
          : recordedPayers.size === 1
            ? [...recordedPayers][0]
            : null;
      const ledgers =
        traceId && payer
          ? (
              await client.query(
                `select id,idempotency_key,delta,metadata->>'operation' as operation,
          metadata->>'modelAlias' as model_alias,metadata->>'profileAlias' as profile_alias,
          metadata->'usage' as usage from usage_ledgers
         where team_id=$1 and actor_user_id=$2 and metadata->>'workspaceId'=$3
          and metadata->>'threadId'=$4 and metadata->>'scopeId'=$5
          and event_type='consume' and unit_type='credit' order by created_at,id`,
                [payer, run.user_id, run.workspace_id, run.thread_id, traceId],
              )
            ).rows
          : [];
      // Keep groups explicit: tool calls can share the same trace/scope as the
      // primary agent, and cannot be added to its displayed charge a second time.
      const groups = new Map<
        string,
        {
          operation: string | null;
          profileAlias: string | null;
          modelAlias: string | null;
          ledgerEntries: number;
          credits: number;
        }
      >();
      for (const ledger of ledgers) {
        const key = JSON.stringify([
          ledger.operation,
          ledger.profile_alias,
          ledger.model_alias,
        ]);
        const group = groups.get(key) ?? {
          operation: ledger.operation,
          profileAlias: ledger.profile_alias,
          modelAlias: ledger.model_alias,
          ledgerEntries: 0,
          credits: 0,
        };
        group.ledgerEntries++;
        group.credits -= ledger.delta;
        groups.set(key, group);
      }
      const generations = traceId
        ? (
            await client.query(
              "select span_id,operation,provider,provider_model,status,total_tokens from llm_generations where team_id=$1 and workspace_id=$2 and trace_id=$3 order by started_at,id",
              [run.team_id, run.workspace_id, traceId],
            )
          ).rows
        : [];
      const settled = snapshot.billing?.consumedCredits;
      const callChecks = belongsToRun
        ? (calls ?? []).map((call) => {
            const key =
              typeof call.idempotencyKey === "string"
                ? scopeMemberLedgerKey(run.user_id, call.idempotencyKey)
                : null;
            const ledger = key
              ? ledgers.find((row) => row.idempotency_key === key)
              : undefined;
            const generation = generations.find(
              (row) => row.span_id === call.observation?.spanId,
            );
            return {
              callId: call.id,
              billingStatus: call.billingStatus,
              ledgerId: ledger?.id ?? null,
              ledgerCreditsMatch:
                call.billingStatus === "metered"
                  ? Boolean(ledger && -ledger.delta === call.consumedCredits)
                  : null,
              generationSpanId: generation?.span_id ?? null,
              generationIdentityMatches: Boolean(
                generation &&
                call.observation?.traceId === traceId &&
                generation.provider === call.observation?.identity?.provider,
              ),
              generationUsageMatches:
                generation && typeof call.usage?.totalTokens === "number"
                  ? generation.total_tokens === call.usage.totalTokens
                  : null,
            };
          })
        : [];
      reports.push({
        runId: id,
        status: run.status,
        traceId,
        billingTeamId: payer,
        messageBelongsToRun: belongsToRun,
        message: belongsToRun
          ? {
              creditsConsumed: message?.credits_consumed,
              callCount: calls?.length ?? null,
              meteredCredits: metadata.meteredLlmCreditsConsumed ?? null,
              usage: metadata.usage ?? null,
            }
          : null,
        snapshot: {
          billedCredits: settled ?? null,
          callCount: snapshot.meteredLlmCalls?.length ?? null,
          meteredCredits: snapshot.meteredLlmCreditsConsumed ?? null,
          usage: snapshot.usage ?? null,
        },
        issues: [
          ...(!traceId ? ["trace_identity_unavailable"] : []),
          ...(!payer ? ["billing_owner_unavailable"] : []),
          ...(!belongsToRun
            ? ["message_now_belongs_to_another_run_or_is_missing"]
            : []),
          ...(belongsToRun &&
          typeof settled === "number" &&
          settled > 0 &&
          !calls?.length
            ? ["settled_call_facts_missing"]
            : []),
          ...(belongsToRun &&
          typeof settled === "number" &&
          metadata.meteredLlmCreditsConsumed !== settled
            ? ["message_and_run_credits_differ"]
            : []),
          ...(callChecks.some((call) => call.ledgerCreditsMatch === false)
            ? ["call_and_ledger_differ"]
            : []),
          ...(callChecks.some(
            (call) =>
              !call.generationIdentityMatches ||
              call.generationUsageMatches === false,
          )
            ? ["call_and_generation_differ"]
            : []),
        ],
        callChecks,
        ledgerGroups: [...groups.values()],
        ledgers,
        generations,
      });
    }
    await client.query("COMMIT");
    const output = JSON.stringify({ readOnly: true, reports }, null, 2) + "\n";
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
