import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AssistantNotifyInput, AssistantPorts } from "../modules/assistants";
import type { StartHostTurnInput } from "../modules/threads";
import type { TeamAuditEntry } from "../modules/team-audit/types";
import { createIsolatedTestDatabase } from "./isolated-database";

/**
 * A migrated database of its own plus the assistants module wired to ports
 * the test controls, mirroring `agent-task-fixture.ts`. Everything that is
 * the module's own (the service, the SQL) is real; what belongs to another
 * module (notifications, audit, the host-started turn, stopping a run) is
 * recorded or scripted here. `workspaceAccess` and `hasCredits` are left as
 * the production implementation: they are themselves plain reads of real
 * rows (organization role, workspace membership, billing), so a test drives
 * them by writing those rows rather than by faking the port.
 */
export async function createAssistantFixture(label: string) {
  const isolated = await createIsolatedTestDatabase(label);
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = isolated.url;
  const schema = await import("@sourceweft/db");
  const assistants = await import("../modules/assistants");
  const { createThreadRecord, findThreadRecord } = await import(
    "../modules/threads/thread/repository"
  );

  const notifications: AssistantNotifyInput[] = [];
  const audits: TeamAuditEntry[] = [];
  const started: StartHostTurnInput[] = [];
  const stopped: Array<{
    workspaceId: string;
    threadId: string;
    runId: string;
    userId: string;
  }> = [];
  const kicked: string[] = [];
  const state = {
    credits: true,
    /** Payers who have no credits left, on top of `credits` (all payers). */
    noCreditsFor: new Set<string>(),
    /** Thrown by the next `startTurn` calls, one per call. */
    startErrors: [] as unknown[],
  };

  const ports: AssistantPorts = {
    workspaceAccess: assistants.assistantPorts.workspaceAccess,
    hasCredits: async ({ userId }) =>
      state.credits && !state.noCreditsFor.has(userId),
    // What `startHostTurn` leaves behind, without a queue or a worker: the
    // conversation (unless it already exists) and a queued chat run, found
    // again by its idempotency key on a replay.
    async startTurn(input) {
      started.push(input);
      const error = state.startErrors.shift();
      if (error) throw error;
      const [workspace] = await schema.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, input.workspaceId));
      const scope = {
        teamId: workspace!.organizationId,
        workspaceId: input.workspaceId,
      };
      if (input.existingThread) {
        const existing = await findThreadRecord({
          ...scope,
          threadId: input.threadId,
        });
        if (!existing || existing.origin !== input.origin) {
          throw new Error(`Test startTurn: no ${input.origin} thread ${input.threadId}`);
        }
      } else {
        await createThreadRecord({
          id: input.threadId,
          ...scope,
          title: input.title,
          createdBy: input.userId,
          origin: input.origin,
          ...(input.visibility ? { visibility: input.visibility } : {}),
        });
      }
      const inserted = await schema.db
        .insert(schema.chatThreadRuns)
        .values({
          id: randomUUID(),
          ...scope,
          threadId: input.threadId,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          mode: "send",
          streamKey: `test:${randomUUID()}`,
          status: "queued",
          requestJson: { content: input.content, unattended: true },
        })
        .onConflictDoNothing()
        .returning();
      const [run] = await schema.db
        .select()
        .from(schema.chatThreadRuns)
        .where(
          and(
            eq(schema.chatThreadRuns.workspaceId, input.workspaceId),
            eq(schema.chatThreadRuns.idempotencyKey, input.idempotencyKey),
          ),
        );
      return {
        thread: { id: input.threadId },
        run: { id: run!.id },
        created: inserted.length > 0,
      };
    },
    // Like `durableChatRunService.stopRun`, only the run's own user may
    // stop it: anyone else gets the same 404 production gives them.
    async stopRun(input) {
      const [run] = await schema.db
        .select({ userId: schema.chatThreadRuns.userId })
        .from(schema.chatThreadRuns)
        .where(eq(schema.chatThreadRuns.id, input.runId));
      if (run && run.userId !== input.userId) {
        throw Object.assign(new Error("Chat run not found"), {
          statusCode: 404,
          code: "CHAT_RUN_NOT_FOUND",
        });
      }
      stopped.push(input);
    },
    async notify(input) {
      notifications.push(input);
      return { id: randomUUID(), merged: false, emailed: false };
    },
    async audit(entry) {
      audits.push(entry);
    },
  };

  async function kickAssistant(input: { assistantId: string }) {
    kicked.push(input.assistantId);
  }

  const service = new assistants.AssistantService(ports, kickAssistant);

  /** A real `user` row: `member`/`workspace_memberships` reference it. */
  async function user(id: string = randomUUID()) {
    await schema.database.query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
      [id, `${id}@example.test`],
    );
    return id;
  }

  /** A real organization, optionally classified personal/team. */
  async function organization(kind?: "personal" | "team") {
    const id = randomUUID();
    await schema.database.query(
      'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
      [id],
    );
    if (kind) {
      await schema.database.query(
        "update organization set metadata = $2 where id = $1",
        [id, JSON.stringify({ sourceweft: { kind } })],
      );
    }
    return id;
  }

  /** A real `member` row: the organization-role plane (owner/admin/member). */
  async function addMember(
    organizationId: string,
    userId: string,
    role: "owner" | "admin" | "member" = "member",
  ) {
    await schema.database.query(
      'insert into member (id,"organizationId","userId",role,"createdAt") values ($1,$2,$3,$4,now())',
      [randomUUID(), organizationId, userId, role],
    );
  }

  /**
   * A team's shared default workspace (so every org member has derived
   * content access, with admins/owners landing on `workspace_admin`), plus
   * one organization member per role given. Each value is `userId` (plain
   * member) unless given as `[userId, role]`.
   */
  async function workspace(
    members: Array<string | [string, "owner" | "admin" | "member"]> = [],
    options: { kind?: "personal" | "team" } = {},
  ) {
    const teamId = await organization(options.kind);
    const workspaceId = randomUUID();
    await schema.db.insert(schema.workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "Assistant workspace",
      slug: workspaceId,
      isDefault: true,
    });
    for (const entry of members) {
      const userId = Array.isArray(entry) ? entry[0] : entry;
      const role = Array.isArray(entry) ? entry[1] : "member";
      await user(userId);
      await addMember(teamId, userId, role);
    }
    return { teamId, workspaceId };
  }

  /** Adds an explicit workspace role override for an existing org member. */
  async function setWorkspaceRole(
    workspaceId: string,
    userId: string,
    role: "workspace_admin" | "editor" | "viewer",
  ) {
    await schema.db
      .insert(schema.workspaceMemberships)
      .values({ workspaceId, userId, role, source: "direct" })
      .onConflictDoUpdate({
        target: [schema.workspaceMemberships.workspaceId, schema.workspaceMemberships.userId],
        set: { role },
      });
  }

  async function assistantRow(workspaceId: string) {
    const [row] = await schema.db
      .select()
      .from(schema.assistants)
      .where(eq(schema.assistants.workspaceId, workspaceId));
    return row ?? null;
  }

  async function feedItemRows(assistantId: string) {
    return schema.db
      .select()
      .from(schema.assistantFeedItems)
      .where(eq(schema.assistantFeedItems.assistantId, assistantId));
  }

  async function triggerRows(assistantId: string) {
    return schema.db
      .select()
      .from(schema.assistantTriggers)
      .where(eq(schema.assistantTriggers.assistantId, assistantId));
  }

  async function triggerRow(id: string) {
    const [row] = await schema.db
      .select()
      .from(schema.assistantTriggers)
      .where(eq(schema.assistantTriggers.id, id));
    return row ?? null;
  }

  async function decisionRows(assistantId: string) {
    return schema.db
      .select()
      .from(schema.assistantDecisions)
      .where(eq(schema.assistantDecisions.assistantId, assistantId));
  }

  /** Inserts a trigger directly, in any status — Task 6's Router is what
   * normally produces these (a member message, via `postMessage`, or a
   * worker report, in Task 7); this fixture skips straight to the row so
   * router tests do not need a real conversation behind each one. */
  async function insertTrigger(input: {
    id?: string;
    teamId: string;
    workspaceId: string;
    assistantId: string;
    sourceKind?: "member_message" | "worker_report";
    payerUserId: string;
    authorUserId?: string | null;
    text?: string;
    status?: "pending_eval" | "in_eval" | "decided" | "unavailable";
    routerBatchKey?: string | null;
    evalAttempts?: number;
    routedTicketId?: string | null;
    ticketId?: string | null;
    deliveredAt?: Date | null;
    createdAt?: Date;
  }) {
    const id = input.id ?? randomUUID();
    await schema.db.insert(schema.assistantTriggers).values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      sourceKind: input.sourceKind ?? "member_message",
      payerUserId: input.payerUserId,
      authorUserId: input.authorUserId ?? input.payerUserId,
      dedupeKey: id,
      text: input.text ?? "Hello",
      status: input.status ?? "pending_eval",
      routerBatchKey: input.routerBatchKey ?? null,
      evalAttempts: input.evalAttempts ?? 0,
      routedTicketId: input.routedTicketId ?? null,
      ticketId: input.ticketId ?? null,
      deliveredAt: input.deliveredAt ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return (await triggerRow(id))!;
  }

  /** Sets `assistants.current_router_run_id`/`current_router_batch_key`
   * directly — Task 7's scheduler tick normally does this once it starts
   * the Router's turn; router tests that exercise `reconcileRouterRun`
   * skip straight to the state it expects. */
  async function setCurrentRouterRun(
    assistantId: string,
    input: { runId: string | null; batchKey: string | null },
  ) {
    await schema.db
      .update(schema.assistants)
      .set({
        currentRouterRunId: input.runId,
        currentRouterBatchKey: input.batchKey,
      })
      .where(eq(schema.assistants.id, assistantId));
    return (await schema.db
      .select()
      .from(schema.assistants)
      .where(eq(schema.assistants.id, assistantId)))[0]!;
  }

  /** Inserts a ticket directly: ticket creation is Task 6-7's Router, not this task's. */
  async function insertTicket(input: {
    id?: string;
    teamId: string;
    workspaceId: string;
    assistantId: string;
    payerUserId: string;
    title?: string;
    stage?: "queued" | "working" | "waiting_person" | "idle" | "ended";
    outcome?: "ready" | "dropped" | "failed" | "blocked" | "waiting" | null;
    blockedReason?: "credit_cap" | "insufficient_credits" | "repeated_failure" | null;
    workerThreadId?: string;
    currentRunId?: string | null;
    consecutiveFailures?: number;
    creditCap?: number;
    createdAt?: Date;
  }) {
    const id = input.id ?? randomUUID();
    await schema.db.insert(schema.assistantTickets).values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      assistantId: input.assistantId,
      workerThreadId: input.workerThreadId ?? randomUUID(),
      title: input.title ?? "Triage the inbox",
      goal: "Keep the inbox at zero",
      payerUserId: input.payerUserId,
      origin: "explicit",
      stage: input.stage ?? "working",
      outcome: input.outcome ?? null,
      blockedReason: input.blockedReason ?? null,
      creditCap: String(input.creditCap ?? 500),
      consecutiveFailures: input.consecutiveFailures ?? 0,
      currentRunId: input.currentRunId ?? null,
      ...(input.createdAt
        ? { createdAt: input.createdAt, updatedAt: input.createdAt }
        : {}),
    });
    const [row] = await schema.db
      .select()
      .from(schema.assistantTickets)
      .where(eq(schema.assistantTickets.id, id));
    return row!;
  }

  async function ticketRow(id: string) {
    const [row] = await schema.db
      .select()
      .from(schema.assistantTickets)
      .where(eq(schema.assistantTickets.id, id));
    return row ?? null;
  }

  async function runRow(id: string) {
    const [row] = await schema.db
      .select()
      .from(schema.chatThreadRuns)
      .where(eq(schema.chatThreadRuns.id, id));
    return row ?? null;
  }

  /** Moves a chat run along as the worker would (finished, failed, ...). */
  async function setRunStatus(
    runId: string,
    input: {
      status:
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "cancelled";
      errorCode?: string | null;
      startedAt?: Date | null;
    },
  ) {
    await schema.db
      .update(schema.chatThreadRuns)
      .set({
        status: input.status,
        errorCode: input.errorCode ?? null,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(["completed", "failed", "cancelled"].includes(input.status)
          ? { finishedAt: new Date() }
          : {}),
      })
      .where(eq(schema.chatThreadRuns.id, runId));
  }

  /** Takes a person out of an organization (and so out of its workspaces). */
  async function removeMember(organizationId: string, userId: string) {
    await schema.database.query(
      'delete from member where "organizationId" = $1 and "userId" = $2',
      [organizationId, userId],
    );
  }

  function reset() {
    notifications.length = 0;
    audits.length = 0;
    started.length = 0;
    stopped.length = 0;
    kicked.length = 0;
    state.credits = true;
    state.noCreditsFor.clear();
    state.startErrors.length = 0;
  }

  return {
    schema,
    assistants,
    service,
    ports,
    state,
    notifications,
    audits,
    started,
    stopped,
    kicked,
    user,
    organization,
    addMember,
    workspace,
    setWorkspaceRole,
    assistantRow,
    feedItemRows,
    triggerRows,
    triggerRow,
    decisionRows,
    insertTicket,
    insertTrigger,
    ticketRow,
    runRow,
    setRunStatus,
    removeMember,
    setCurrentRouterRun,
    reset,
    async close() {
      await schema.database.end();
      await isolated.close();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    },
  };
}

export type AssistantFixture = Awaited<ReturnType<typeof createAssistantFixture>>;
