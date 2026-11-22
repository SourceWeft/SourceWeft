/**
 * The P1 real-model evaluation (#692, Task 10). Not part of CI and not
 * imported by production code.
 *
 * Against a local stack (a throwaway database and Redis, and the eval worker
 * `eval/worker-entry.ts` running so chat runs execute), this:
 *
 *   1. creates a fresh team organization, its default workspace and three
 *      members (`p1-stream.ts`), and enables the assistant as the owner;
 *   2. drives `runAssistantTick()` in a loop, as the scheduler would;
 *   3. posts the stream phase by phase through `assistantService.postMessage`
 *      (which kicks the Router), waiting for the assistant to go idle after
 *      each phase;
 *   4. reads back every message's trigger and decision and prints the
 *      metrics: explicit-request recall, follow-up / cancellation routing,
 *      chatter ignored, undecided events, Router run count and credits.
 *
 * Run: pnpm --filter @sourceweft/backend exec tsx src/modules/assistants/eval/run.ts [--out result.json]
 */
import "./require-eval-database";
import "../../../shared/config";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { database } from "@sourceweft/db";
import { assistantService, runAssistantTick } from "..";
import {
  P1_EXPECTED_ACTION,
  P1_MEMBERS,
  P1_PHASES,
  P1_STREAM,
  type P1Member,
  type P1Message,
} from "./p1-stream";

const TICK_INTERVAL_MS = 1_500;
const POLL_INTERVAL_MS = 2_000;
/** A phase that is still busy after this is recorded and the run moves on. */
const PHASE_TIMEOUT_MS = 15 * 60_000;
/** Idle must hold for this long (the tick may be about to start something). */
const IDLE_CONFIRM_MS = 5_000;

const THRESHOLDS = {
  requestRecall: 1,
  undecided: 0,
  followupRouting: 0.85,
  chatterIgnored: 0.85,
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await database.query(text, params);
  return result.rows as T[];
}

// ── Setup ───────────────────────────────────────────────────────────────

async function createWorkspace(runId: string) {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  await query(
    'insert into organization (id,name,slug,"createdAt",metadata) values ($1,$2,$3,now(),$4)',
    [
      teamId,
      `Assistant eval ${runId}`,
      `assistant-eval-${runId}`,
      JSON.stringify({ sourceweft: { kind: "team" } }),
    ],
  );
  await query(
    `insert into workspaces (id, organization_id, name, slug, is_default)
     values ($1, $2, $3, $4, true)`,
    [workspaceId, teamId, "Assistant eval", `assistant-eval-${runId}`],
  );
  const users = {} as Record<P1Member, string>;
  for (const [member, info] of Object.entries(P1_MEMBERS) as Array<
    [P1Member, (typeof P1_MEMBERS)[P1Member]]
  >) {
    const userId = randomUUID();
    await query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())',
      [userId, info.name, `${member}-${runId}@assistant-eval.test`],
    );
    await query(
      'insert into member (id,"organizationId","userId",role,"createdAt") values ($1,$2,$3,$4,now())',
      [randomUUID(), teamId, userId, info.role],
    );
    users[member] = userId;
  }
  return { teamId, workspaceId, users };
}

// ── Waiting for the assistant to go idle ────────────────────────────────

type Busy = {
  openTriggers: number;
  routerRunning: boolean;
  workerRunning: number;
  queuedTickets: number;
  undelivered: number;
};

async function busyState(assistantId: string): Promise<Busy> {
  const [row] = await query<{
    open_triggers: string;
    router_run: string | null;
    worker_running: string;
    queued_tickets: string;
    undelivered: string;
  }>(
    `select
       (select count(*) from assistant_triggers
         where assistant_id = $1 and status in ('pending_eval','in_eval')) as open_triggers,
       (select current_router_run_id from assistants where id = $1) as router_run,
       (select count(*) from assistant_tickets
         where assistant_id = $1 and current_run_id is not null) as worker_running,
       (select count(*) from assistant_tickets
         where assistant_id = $1 and stage = 'queued') as queued_tickets,
       (select count(*) from assistant_triggers t
          join assistant_tickets k on k.id = t.routed_ticket_id
         where t.assistant_id = $1 and t.delivered_at is null
           and k.stage not in ('ended','working')) as undelivered`,
    [assistantId],
  );
  return {
    openTriggers: Number(row!.open_triggers),
    routerRunning: row!.router_run !== null,
    workerRunning: Number(row!.worker_running),
    queuedTickets: Number(row!.queued_tickets),
    undelivered: Number(row!.undelivered),
  };
}

function isIdle(busy: Busy) {
  return (
    busy.openTriggers === 0 &&
    !busy.routerRunning &&
    busy.workerRunning === 0 &&
    busy.queuedTickets === 0 &&
    busy.undelivered === 0
  );
}

async function failedRunsSince(workspaceId: string, since: Date) {
  return query<{
    id: string;
    thread_id: string;
    error_code: string | null;
    error_message: string | null;
  }>(
    `select id, thread_id, error_code, left(error_message, 300) as error_message
       from chat_thread_runs
      where workspace_id = $1 and status = 'failed' and created_at >= $2
      order by created_at`,
    [workspaceId, since],
  );
}

async function waitIdle(
  assistantId: string,
  workspaceId: string,
  label: string,
): Promise<{ timedOut: boolean; ms: number }> {
  const started = Date.now();
  const seenFailures = new Set<string>();
  let idleSince: number | null = null;
  let lastLog = 0;
  for (;;) {
    const busy = await busyState(assistantId);
    for (const run of await failedRunsSince(
      workspaceId,
      new Date(started - 60_000),
    )) {
      if (seenFailures.has(run.id)) continue;
      seenFailures.add(run.id);
      console.log(
        `  [${label}] run ${run.id} failed: ${run.error_code ?? "-"} ${run.error_message ?? ""}`,
      );
    }
    const now = Date.now();
    if (isIdle(busy)) {
      idleSince ??= now;
      if (now - idleSince >= IDLE_CONFIRM_MS) {
        return { timedOut: false, ms: now - started };
      }
    } else {
      idleSince = null;
    }
    if (now - started > PHASE_TIMEOUT_MS) {
      console.log(
        `  [${label}] still busy after ${PHASE_TIMEOUT_MS / 60_000} min: ${JSON.stringify(busy)}`,
      );
      return { timedOut: true, ms: now - started };
    }
    if (now - lastLog > 30_000) {
      lastLog = now;
      console.log(
        `  [${label}] waiting ${Math.round((now - started) / 1000)}s ${JSON.stringify(busy)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Scoring ─────────────────────────────────────────────────────────────

type TriggerOutcome = {
  key: string;
  member: P1Member;
  kind: P1Message["kind"];
  target: string | null;
  text: string;
  expected: string;
  triggerId: string;
  status: string;
  evalAttempts: number;
  action: string | null;
  routedTicketId: string | null;
  expectedTicketId: string | null;
  reason: string | null;
  correct: boolean;
};

async function score(input: {
  assistantId: string;
  workspaceId: string;
  routerThreadId: string;
  triggerIds: Map<string, string>;
}) {
  const triggers = await query<{
    id: string;
    source_kind: string;
    status: string;
    eval_attempts: number;
    routed_ticket_id: string | null;
    router_batch_key: string | null;
  }>(
    `select id, source_kind, status, eval_attempts, routed_ticket_id, router_batch_key
       from assistant_triggers where assistant_id = $1`,
    [input.assistantId],
  );
  const decisions = await query<{
    trigger_id: string;
    router_batch_key: string;
    action: string;
    ticket_id: string | null;
    reason: string | null;
  }>(
    `select trigger_id, router_batch_key, action, ticket_id, reason
       from assistant_decisions where assistant_id = $1 order by created_at`,
    [input.assistantId],
  );
  const triggerById = new Map(triggers.map((row) => [row.id, row]));
  const decisionOf = (triggerId: string) => {
    const trigger = triggerById.get(triggerId);
    const rows = decisions.filter((row) => row.trigger_id === triggerId);
    return (
      rows.find((row) => row.router_batch_key === trigger?.router_batch_key) ??
      rows.at(-1) ??
      null
    );
  };

  const outcomes: TriggerOutcome[] = [];
  const byKey = new Map<string, TriggerOutcome>();
  for (const message of P1_STREAM) {
    const triggerId = input.triggerIds.get(message.key)!;
    const trigger = triggerById.get(triggerId);
    const decision = decisionOf(triggerId);
    const routedTicketId = trigger?.routed_ticket_id ?? null;
    const expectedTicketId = message.target
      ? (byKey.get(message.target)?.routedTicketId ?? null)
      : null;
    const action =
      trigger?.status === "decided" ? (decision?.action ?? null) : null;
    let correct = false;
    if (message.kind === "request") correct = action === "create_ticket";
    else if (message.kind === "chatter") correct = action === "ignore";
    else {
      correct =
        action === "route_to_ticket" &&
        expectedTicketId !== null &&
        routedTicketId === expectedTicketId;
    }
    const outcome: TriggerOutcome = {
      key: message.key,
      member: message.member,
      kind: message.kind,
      target: message.target ?? null,
      text: message.text,
      expected: P1_EXPECTED_ACTION[message.kind],
      triggerId,
      status: trigger?.status ?? "missing",
      evalAttempts: trigger?.eval_attempts ?? 0,
      action,
      routedTicketId,
      expectedTicketId,
      reason: decision?.reason ?? null,
      correct,
    };
    outcomes.push(outcome);
    byKey.set(message.key, outcome);
  }

  const ofKind = (kind: P1Message["kind"]) =>
    outcomes.filter((o) => o.kind === kind);
  const rate = (rows: TriggerOutcome[]) =>
    rows.length === 0 ? 1 : rows.filter((o) => o.correct).length / rows.length;

  const reportTriggers = triggers.filter(
    (row) => row.source_kind === "worker_report",
  );
  const reportActions: Record<string, number> = {};
  for (const row of reportTriggers) {
    const action =
      row.status === "decided"
        ? (decisionOf(row.id)?.action ?? "?")
        : row.status;
    reportActions[action] = (reportActions[action] ?? 0) + 1;
  }

  const [tickets] = await query<{ count: string }>(
    "select count(*) from assistant_tickets where assistant_id = $1",
    [input.assistantId],
  );
  const [says] = await query<{ count: string }>(
    "select count(*) from assistant_feed_items where assistant_id = $1 and kind = 'router_message'",
    [input.assistantId],
  );

  const runStats = (where: string, params: unknown[]) =>
    query<{
      runs: string;
      completed: string;
      failed: string;
      credits: string | null;
      null_credits: string;
    }>(
      `select count(*) as runs,
              count(*) filter (where status = 'completed') as completed,
              count(*) filter (where status = 'failed') as failed,
              sum(consumed_credits) as credits,
              count(*) filter (where consumed_credits is null) as null_credits
         from chat_thread_runs where ${where}`,
      params,
    ).then(([row]) => ({
      runs: Number(row!.runs),
      completed: Number(row!.completed),
      failed: Number(row!.failed),
      consumedCredits: Number(row!.credits ?? 0),
      runsWithoutCredits: Number(row!.null_credits),
    }));
  const router = await runStats("workspace_id = $1 and thread_id = $2", [
    input.workspaceId,
    input.routerThreadId,
  ]);
  const workers = await runStats(
    `workspace_id = $1 and thread_id in (select worker_thread_id from assistant_tickets where assistant_id = $2)`,
    [input.workspaceId, input.assistantId],
  );
  const generations = await query<{
    thread_kind: string;
    provider: string | null;
    model: string | null;
    calls: string;
    input_tokens: string | null;
    cache_read_tokens: string | null;
    output_tokens: string | null;
    cost_usd: string | null;
  }>(
    // One row per provider call (`chat.complete`); the `chat.stream` rows
    // above them repeat the same tokens per turn.
    `select case when g.thread_id = $2 then 'router' else 'worker' end as thread_kind,
            g.provider, coalesce(g.resolved_provider_model, g.provider_model) as model,
            count(*) as calls, sum(g.input_tokens) as input_tokens,
            sum(g.cache_read_tokens) as cache_read_tokens,
            sum(g.output_tokens) as output_tokens, sum(g.provider_cost_usd) as cost_usd
       from llm_generations g
      where g.workspace_id = $1 and g.operation = 'chat.complete'
      group by 1, 2, 3 order by 1, 2, 3`,
    [input.workspaceId, input.routerThreadId],
  );

  const undecidedMembers = outcomes.filter(
    (o) => o.status !== "decided",
  ).length;
  const metrics = {
    requestRecall: rate(ofKind("request")),
    followupRouting: rate(ofKind("followup")),
    cancelRouting: rate(ofKind("cancel")),
    followupAndCancelRouting: rate([
      ...ofKind("followup"),
      ...ofKind("cancel"),
    ]),
    chatterIgnored: rate(ofKind("chatter")),
    undecidedMemberEvents: undecidedMembers,
    undecidedReportEvents: reportTriggers.filter(
      (row) => row.status !== "decided",
    ).length,
    workerReportDecisions: reportActions,
    ticketsCreated: Number(tickets!.count),
    routerSays: Number(says!.count),
    router,
    workers,
    generations,
  };
  const pass =
    metrics.requestRecall >= THRESHOLDS.requestRecall &&
    metrics.undecidedMemberEvents + metrics.undecidedReportEvents <=
      THRESHOLDS.undecided &&
    metrics.followupRouting >= THRESHOLDS.followupRouting &&
    metrics.chatterIgnored >= THRESHOLDS.chatterIgnored;
  return { metrics, pass, outcomes };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: { out: { type: "string" } },
  });
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date();
  console.log(`P1 eval ${runId} starting at ${startedAt.toISOString()}`);

  const { workspaceId, users } = await createWorkspace(runId);
  const owner = { workspaceId, userId: users.lin };
  const assistant = await assistantService.enable(owner);
  console.log(`  workspace ${workspaceId}, assistant ${assistant.id}`);

  let ticking = true;
  const tickLoop = (async () => {
    while (ticking) {
      try {
        await runAssistantTick();
      } catch (error) {
        console.log(
          `  tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(TICK_INTERVAL_MS);
    }
  })();

  const triggerIds = new Map<string, string>();
  const phases: Array<{ phase: number; ms: number; timedOut: boolean }> = [];
  try {
    for (const [index, phase] of P1_PHASES.entries()) {
      const label = `phase ${index + 1}/${P1_PHASES.length}`;
      for (const message of phase) {
        const posted = await assistantService.postMessage(
          { workspaceId, userId: users[message.member] },
          {
            text: message.text,
            idempotencyKey: `p1-eval:${runId}:${message.key}`,
          },
        );
        triggerIds.set(message.key, posted.item.id);
      }
      console.log(`  [${label}] posted ${phase.map((m) => m.key).join(", ")}`);
      const waited = await waitIdle(assistant.id, workspaceId, label);
      phases.push({ phase: index + 1, ...waited });
      console.log(`  [${label}] idle after ${Math.round(waited.ms / 1000)}s`);
    }
  } finally {
    ticking = false;
    await tickLoop;
  }

  // Paused once scored, so a later run's ticks leave this one alone.
  const { assistant: current } = await assistantService.get(owner);
  if (current) {
    await assistantService.update(owner, {
      version: current.version,
      action: "pause",
    });
  }

  const result = await score({
    assistantId: assistant.id,
    workspaceId,
    routerThreadId: assistant.routerThreadId,
    triggerIds,
  });
  const finishedAt = new Date();
  const { metrics } = result;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log("");
  console.log(
    `P1 eval ${runId} finished in ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)}s`,
  );
  console.log(
    `  explicit-request recall   ${pct(metrics.requestRecall)} (threshold 100%)`,
  );
  console.log(
    `  follow-up routing         ${pct(metrics.followupRouting)} (threshold >= 85%)`,
  );
  console.log(`  cancellation routing      ${pct(metrics.cancelRouting)}`);
  console.log(
    `  chatter ignored           ${pct(metrics.chatterIgnored)} (threshold >= 85%)`,
  );
  console.log(
    `  undecided events          ${metrics.undecidedMemberEvents} member + ${metrics.undecidedReportEvents} worker report (threshold 0)`,
  );
  console.log(
    `  worker report decisions   ${JSON.stringify(metrics.workerReportDecisions)}`,
  );
  console.log(
    `  tickets created           ${metrics.ticketsCreated}; router say ${metrics.routerSays}`,
  );
  console.log(
    `  router runs               ${metrics.router.runs} (failed ${metrics.router.failed}), consumed_credits ${metrics.router.consumedCredits}`,
  );
  console.log(
    `  worker runs               ${metrics.workers.runs} (failed ${metrics.workers.failed}), consumed_credits ${metrics.workers.consumedCredits}`,
  );
  console.log(
    `  phase timeouts            ${phases.filter((p) => p.timedOut).length}`,
  );
  console.log(`  RESULT                    ${result.pass ? "PASS" : "FAIL"}`);
  for (const outcome of result.outcomes.filter((o) => !o.correct)) {
    console.log(
      `  miss ${outcome.key} (${outcome.kind}${outcome.target ? ` -> ${outcome.target}` : ""}): expected ${outcome.expected}, got ${outcome.action ?? outcome.status}` +
        (outcome.routedTicketId && outcome.kind !== "request"
          ? ` ticket ${outcome.routedTicketId === outcome.expectedTicketId ? "=" : "!="} target`
          : "") +
        (outcome.reason ? ` reason: ${outcome.reason}` : ""),
    );
  }

  if (values.out) {
    await writeFile(
      values.out,
      JSON.stringify(
        {
          runId,
          workspaceId,
          assistantId: assistant.id,
          startedAt,
          finishedAt,
          phases,
          ...result,
        },
        null,
        2,
      ),
    );
  }
}

try {
  await main();
} finally {
  await database.end();
}
process.exit(0);
