import { randomUUID } from "node:crypto";
import { db } from "@sourceweft/db";
import type {
  Assistant,
  AssistantFeedItem,
  AssistantStatus,
  AssistantStatusReason,
  AssistantTicket,
  PostAssistantMessageRequest,
  TicketActionRequest,
  TicketStage,
  UpdateAssistantRequest,
} from "@sourceweft/contracts/assistants";
// The deterministic-id helper is owned by agent-tasks (spec: "one tool, no
// new hash function"); it is not re-exported from the module's index, so the
// import reaches past it on purpose.
import { deterministicId } from "../agent-tasks/runs";
import { logger } from "../../shared/logger";
import { AssistantError } from "./errors";
import { assistantPorts, type AssistantPorts } from "./ports";
import {
  endTicketRow,
  findAssistantRow,
  findChatRunRow,
  findFeedItemRow,
  findTicketRow,
  findTriggerRow,
  insertAssistantRow,
  insertFeedItemRow,
  insertTriggerRow,
  listFeedItemRows,
  listTicketRows,
  resetTicketFailuresRow,
  updateAssistantRow,
  uniqueViolation,
  type AssistantFeedItemRow,
  type AssistantRow,
  type AssistantTicketRow,
} from "./repository";

/** Who is asking, and in which workspace. */
type Caller = { workspaceId: string; userId: string };

/** The standing resolved by `ports.workspaceAccess`. */
type Access = { teamId: string; canWrite: boolean; isContainerAdmin: boolean };

const DEFAULT_FEED_PAGE = 50;

function notFound() {
  return new AssistantError(404, "ASSISTANT_NOT_FOUND", "Assistant not found");
}

function ticketNotFound() {
  return new AssistantError(
    404,
    "ASSISTANT_TICKET_NOT_FOUND",
    "Ticket not found",
  );
}

function forbidden(message: string, code = "ASSISTANT_FORBIDDEN") {
  return new AssistantError(403, code, message);
}

function alreadyEnabled() {
  return new AssistantError(
    409,
    "ASSISTANT_ALREADY_ENABLED",
    "The workspace assistant is already enabled",
  );
}

function versionConflict(version: number) {
  return new AssistantError(
    409,
    "ASSISTANT_VERSION_CONFLICT",
    "This assistant was changed somewhere else. Reload it and try again.",
    { version },
  );
}

function pausedError() {
  return new AssistantError(
    409,
    "ASSISTANT_PAUSED",
    "The workspace assistant is paused",
  );
}

function presentAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    routerThreadId: row.routerThreadId,
    stewardUserId: row.stewardUserId,
    status: row.status,
    statusReason: row.statusReason ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentTicket(row: AssistantTicketRow): AssistantTicket {
  return {
    id: row.id,
    assistantId: row.assistantId,
    workerThreadId: row.workerThreadId,
    title: row.title,
    goal: row.goal,
    payerUserId: row.payerUserId,
    origin: row.origin,
    stage: row.stage,
    outcome: row.outcome ?? null,
    blockedReason: row.blockedReason ?? null,
    creditCap: Number(row.creditCap),
    consecutiveFailures: row.consecutiveFailures,
    lastReportSummary: row.lastReportSummary ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

function presentFeedItem(row: AssistantFeedItemRow): AssistantFeedItem {
  return {
    id: row.id,
    assistantId: row.assistantId,
    kind: row.kind,
    authorUserId: row.authorUserId ?? null,
    text: row.text,
    ticketId: row.ticketId ?? null,
    replyToItemId: row.replyToItemId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AssistantService {
  constructor(
    private readonly ports: AssistantPorts = assistantPorts,
    /**
     * Wakes the Router so it looks at what is waiting for it. A no-op by
     * default (tests); the production singleton below passes
     * `dispatch.ts#kickAssistant`, which never throws. Called after a
     * brand-new member message commits, never on a replay.
     */
    private readonly kickAssistant: (assistant: {
      assistantId: string;
      teamId: string;
      workspaceId: string;
    }) => Promise<void> = async () => {
      /* no-op unless wired */
    },
  ) {}

  /** The caller's standing in the workspace, or a 404 for a non-member. */
  private async requireAccess(caller: Caller): Promise<Access> {
    const access = await this.ports.workspaceAccess(caller);
    if (!access) throw notFound();
    return access;
  }

  /** The workspace's one assistant row, or `notFound`'s 404. */
  private async requireAssistant(
    caller: Caller,
    access: Access,
  ): Promise<AssistantRow> {
    const row = await findAssistantRow({
      workspaceId: caller.workspaceId,
      teamId: access.teamId,
    });
    if (!row) throw notFound();
    return row;
  }

  /**
   * Whether a newly created Router conversation should be visible to the
   * whole workspace (a team workspace) rather than only its creator (a
   * personal one, the default when the organization cannot be classified at
   * all is "workspace" — see modules/workspace/service.ts
   * `ensureMembershipWorkspace`, which draws the same personal/team line from
   * the organization's metadata).
   */
  private async routerThreadVisibility(
    teamId: string,
  ): Promise<"workspace" | undefined> {
    const { workspaceService } = await import("../workspace");
    const { isPersonalOrganizationMetadata } = await import(
      "../auth/organization-metadata"
    );
    const organization = await workspaceService.getOrganization(teamId);
    if (organization && isPersonalOrganizationMetadata(organization.metadata)) {
      // Personal workspace: leave visibility unset so createThreadRecord's
      // default ("private") applies.
      return undefined;
    }
    return "workspace";
  }

  /**
   * Enables the workspace assistant. Only a container admin may: this stands
   * up a standing conversation and a steward responsibility, not an
   * ordinary piece of content. The Router thread is pre-created with a
   * deterministic id before the assistant row is written, so the row never
   * points at a thread that does not exist; since the thread carries no
   * foreign key (by design — see packages/db/src/schema/assistants.ts) and
   * its creation is idempotent (same id, `on conflict do nothing`), creating
   * it first and failing the transaction after (e.g. a concurrent enable)
   * only ever leaves behind a harmless, unreferenced row.
   *
   * Two container admins racing to enable the same workspace both compute
   * the same deterministic thread id. `createThreadRecord`'s own replay path
   * (used by every caller, not something to change here) re-reads the row by
   * `created_by = caller`, so the *loser* of the race — whose insert hit the
   * winner's `on conflict do nothing` — finds no row of its own and throws a
   * plain, untyped `Error`. We look the thread up first and skip creating it
   * when it is already there; if it still isn't there yet and creation then
   * fails, we look again rather than assume the failure is real — the
   * winner's commit and our lookup are not ordered, so a thread that exists
   * now is the race resolving in our favor, harmless, and left for the
   * `assistants`-row transaction below (which already turns a concurrent
   * insert into `ASSISTANT_ALREADY_ENABLED`) to settle who actually enabled
   * it. Only a thread that is still missing after that recheck is a genuine
   * failure, and is rethrown rather than swallowed.
   */
  async enable(caller: Caller): Promise<Assistant> {
    const access = await this.requireAccess(caller);
    if (!access.isContainerAdmin) {
      throw forbidden("Only a workspace administrator can enable the assistant");
    }

    const existing = await findAssistantRow({
      workspaceId: caller.workspaceId,
      teamId: access.teamId,
    });
    if (existing) throw alreadyEnabled();

    const routerThreadId = deterministicId("assistant-router", caller.workspaceId);
    const { createThreadRecord, findThreadRecord } = await import(
      "../threads/thread/repository"
    );
    const threadScope = { teamId: access.teamId, workspaceId: caller.workspaceId };
    const priorThread = await findThreadRecord({
      ...threadScope,
      threadId: routerThreadId,
    });
    if (!priorThread) {
      const visibility = await this.routerThreadVisibility(access.teamId);
      try {
        await createThreadRecord({
          id: routerThreadId,
          ...threadScope,
          title: "Workspace assistant",
          createdBy: caller.userId,
          origin: "assistant_router",
          ...(visibility ? { visibility } : {}),
        });
      } catch (error) {
        const nowThere = await findThreadRecord({
          ...threadScope,
          threadId: routerThreadId,
        });
        if (!nowThere) throw error;
      }
    }

    const now = new Date();
    let row: AssistantRow;
    try {
      row = await db.transaction(async (tx) => {
        const alreadyThere = await findAssistantRow(
          { workspaceId: caller.workspaceId, teamId: access.teamId },
          tx,
          { forUpdate: true },
        );
        if (alreadyThere) throw alreadyEnabled();
        return insertAssistantRow(tx, {
          id: randomUUID(),
          teamId: access.teamId,
          workspaceId: caller.workspaceId,
          routerThreadId,
          stewardUserId: caller.userId,
          createdBy: caller.userId,
          now,
        });
      });
    } catch (error) {
      if (uniqueViolation(error) === "assistants_workspace_uq") {
        throw alreadyEnabled();
      }
      throw error;
    }

    await this.ports.audit({
      teamId: access.teamId,
      actorUserId: caller.userId,
      action: "assistant.enabled",
      targetType: "assistant",
      targetId: row.id,
      metadata: { workspaceId: caller.workspaceId, routerThreadId },
    });

    return presentAssistant(row);
  }

  async get(caller: Caller): Promise<{ assistant: Assistant | null }> {
    const access = await this.requireAccess(caller);
    const row = await findAssistantRow({
      workspaceId: caller.workspaceId,
      teamId: access.teamId,
    });
    return { assistant: row ? presentAssistant(row) : null };
  }

  /**
   * Pauses/resumes (write access) and/or changes the steward (container
   * admin; the new steward must still be able to reach this workspace).
   * Checked against `input.version`; a stale one is a 409.
   */
  async update(
    caller: Caller,
    input: UpdateAssistantRequest,
  ): Promise<{ assistant: Assistant }> {
    const access = await this.requireAccess(caller);
    const now = new Date();
    let pausedChanged = false;
    let resumedChanged = false;
    let stewardChange: { from: string; to: string } | null = null;

    const updated = await db.transaction(async (tx) => {
      const row = await findAssistantRow(
        { workspaceId: caller.workspaceId, teamId: access.teamId },
        tx,
        { forUpdate: true },
      );
      if (!row) throw notFound();
      if (row.version !== input.version) throw versionConflict(row.version);

      const values: {
        status?: AssistantStatus;
        statusReason?: AssistantStatusReason | null;
        stewardUserId?: string;
        version?: number;
        updatedAt?: Date;
      } = {};

      if (input.action) {
        if (!access.canWrite) {
          throw forbidden("You do not have write access to this workspace");
        }
        if (input.action === "pause") {
          values.status = "paused";
          values.statusReason = "by_admin";
          pausedChanged = true;
        } else {
          values.status = "active";
          values.statusReason = null;
          resumedChanged = true;
        }
      }

      if (input.stewardUserId !== undefined) {
        if (!access.isContainerAdmin) {
          throw forbidden("Only a workspace administrator can change the steward");
        }
        if (input.stewardUserId !== row.stewardUserId) {
          const stewardAccess = await this.ports.workspaceAccess({
            workspaceId: caller.workspaceId,
            userId: input.stewardUserId,
          });
          if (!stewardAccess) {
            throw forbidden(
              "The new steward must be able to access this workspace",
            );
          }
          stewardChange = { from: row.stewardUserId, to: input.stewardUserId };
          values.stewardUserId = input.stewardUserId;
        }
      }

      if (!pausedChanged && !resumedChanged && !stewardChange) {
        // Nothing actually changed; leave the row (and its version) as is.
        return row;
      }

      values.version = row.version + 1;
      values.updatedAt = now;
      return updateAssistantRow(tx, row.id, values);
    });

    if (pausedChanged) {
      await this.ports.audit({
        teamId: access.teamId,
        actorUserId: caller.userId,
        action: "assistant.paused",
        targetType: "assistant",
        targetId: updated.id,
        metadata: { reason: "by_admin" },
      });
    }
    if (resumedChanged) {
      await this.ports.audit({
        teamId: access.teamId,
        actorUserId: caller.userId,
        action: "assistant.resumed",
        targetType: "assistant",
        targetId: updated.id,
      });
    }
    if (stewardChange) {
      await this.ports.audit({
        teamId: access.teamId,
        actorUserId: caller.userId,
        action: "assistant.steward_changed",
        targetType: "assistant",
        targetId: updated.id,
        metadata: stewardChange,
      });
    }

    return { assistant: presentAssistant(updated) };
  }

  /**
   * A member's message to the assistant. `idempotencyKey` derives both the
   * feed item's id and its trigger's (same value used as the trigger's
   * primary key and its `dedupe_key`), so a double-click or a network retry
   * produces exactly one feed item and one trigger — never a 409, the
   * replay is just handed back with `created: false`. `kickAssistant` is
   * only called for a genuinely new message, after the write commits.
   */
  async postMessage(
    caller: Caller,
    input: PostAssistantMessageRequest,
  ): Promise<{ item: AssistantFeedItem; created: boolean }> {
    const access = await this.requireAccess(caller);
    if (!access.canWrite) {
      throw forbidden("You do not have write access to this workspace");
    }
    const assistant = await this.requireAssistant(caller, access);

    const id = deterministicId(
      "assistant-msg",
      assistant.id,
      caller.userId,
      input.idempotencyKey,
    );
    const existing = await findFeedItemRow({
      id,
      teamId: assistant.teamId,
      workspaceId: assistant.workspaceId,
      assistantId: assistant.id,
    });
    if (existing) return { item: presentFeedItem(existing), created: false };

    if (assistant.status === "paused") throw pausedError();

    let created: AssistantFeedItemRow;
    try {
      created = await db.transaction(async (tx) => {
        await insertTriggerRow(tx, {
          id,
          teamId: assistant.teamId,
          workspaceId: assistant.workspaceId,
          assistantId: assistant.id,
          sourceKind: "member_message",
          payerUserId: caller.userId,
          authorUserId: caller.userId,
          dedupeKey: id,
          text: input.text,
          status: "pending_eval",
        });
        return insertFeedItemRow(tx, {
          id,
          teamId: assistant.teamId,
          workspaceId: assistant.workspaceId,
          assistantId: assistant.id,
          kind: "member_message",
          authorUserId: caller.userId,
          text: input.text,
          triggerId: id,
        });
      });
    } catch (error) {
      if (uniqueViolation(error)) {
        // Raced with another request carrying the same idempotency key.
        const replay = await findFeedItemRow({
          id,
          teamId: assistant.teamId,
          workspaceId: assistant.workspaceId,
          assistantId: assistant.id,
        });
        if (replay) return { item: presentFeedItem(replay), created: false };
      }
      throw error;
    }

    await this.kickAssistant({
      assistantId: assistant.id,
      teamId: assistant.teamId,
      workspaceId: assistant.workspaceId,
    });
    return { item: presentFeedItem(created), created: true };
  }

  async listFeed(
    caller: Caller,
    input: { before?: string; limit?: number } = {},
  ): Promise<{ items: AssistantFeedItem[]; nextCursor: string | null }> {
    const access = await this.requireAccess(caller);
    const assistant = await this.requireAssistant(caller, access);
    const limit = input.limit ?? DEFAULT_FEED_PAGE;
    const rows = await listFeedItemRows({
      teamId: assistant.teamId,
      workspaceId: assistant.workspaceId,
      assistantId: assistant.id,
      before: input.before,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(presentFeedItem),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async listTickets(
    caller: Caller,
    input: { stage?: TicketStage } = {},
  ): Promise<{ tickets: AssistantTicket[] }> {
    const access = await this.requireAccess(caller);
    const assistant = await this.requireAssistant(caller, access);
    const rows = await listTicketRows({
      assistantId: assistant.id,
      stage: input.stage,
    });
    return { tickets: rows.map(presentTicket) };
  }

  private async requireTicket(caller: Caller, ticketId: string) {
    const access = await this.requireAccess(caller);
    const assistant = await findAssistantRow({
      workspaceId: caller.workspaceId,
      teamId: access.teamId,
    });
    if (!assistant) throw ticketNotFound();
    const ticket = await findTicketRow({ ticketId, assistantId: assistant.id });
    if (!ticket) throw ticketNotFound();
    return { access, assistant, ticket };
  }

  /**
   * Ends a ticket. Already-ended is a no-op (idempotent), not an error. A
   * worker run still going for it is stopped first — as the run's own user
   * (its payer), the same way the dispatch tick stops a run past its time
   * limit: only a run's own user may stop it, and whoever closes the ticket
   * (the steward, any member with write access) is often someone else.
   */
  async closeTicket(
    caller: Caller,
    ticketId: string,
    _input: TicketActionRequest,
  ): Promise<{ ticket: AssistantTicket }> {
    const { access, ticket } = await this.requireTicket(caller, ticketId);
    if (!access.canWrite) {
      throw forbidden("You do not have write access to this workspace");
    }
    if (ticket.stage === "ended") {
      return { ticket: presentTicket(ticket) };
    }
    if (ticket.currentRunId) {
      const run = await findChatRunRow({
        runId: ticket.currentRunId,
        teamId: access.teamId,
        workspaceId: caller.workspaceId,
      });
      // A run that is gone has nothing left to stop.
      if (run) {
        await this.ports.stopRun({
          workspaceId: caller.workspaceId,
          threadId: ticket.workerThreadId,
          runId: run.id,
          userId: run.userId,
        });
      }
    }
    const updated = await endTicketRow(db, {
      ticketId: ticket.id,
      now: new Date(),
    });
    return { ticket: presentTicket(updated) };
  }

  /**
   * Routes one more already-decided event straight to the ticket, skipping
   * router evaluation, and clears its failure count — the member's signal
   * that it is worth another attempt. `idempotencyKey` derives the trigger's
   * id, so a repeated click adds no second event (the failure count is
   * simply reset again, which is harmless); `created` tells the caller
   * whether this call is the one that recorded the retry (`true`) or an
   * idempotent replay of one that already had (`false`), the same
   * created/replayed distinction `postMessage` reports.
   *
   * Only the ticket's payer may retry it: the run it starts is billed to
   * them, and nobody else may spend their credits.
   */
  async retryTicket(
    caller: Caller,
    ticketId: string,
    input: TicketActionRequest,
  ): Promise<{ ticket: AssistantTicket; created: boolean }> {
    const { access, assistant, ticket } = await this.requireTicket(
      caller,
      ticketId,
    );
    if (!access.canWrite) {
      throw forbidden("You do not have write access to this workspace");
    }
    if (ticket.payerUserId !== caller.userId) {
      throw forbidden(
        "Only the member who pays for this ticket can retry it",
        "ASSISTANT_TICKET_NOT_PAYER",
      );
    }

    const triggerId = deterministicId(
      "assistant-retry",
      ticket.id,
      input.idempotencyKey,
    );
    const now = new Date();
    let updated: AssistantTicketRow;
    let created = false;
    try {
      updated = await db.transaction(async (tx) => {
        const existingTrigger = await findTriggerRow(
          {
            id: triggerId,
            teamId: assistant.teamId,
            workspaceId: assistant.workspaceId,
            assistantId: assistant.id,
          },
          tx,
        );
        if (!existingTrigger) {
          created = true;
          await insertTriggerRow(tx, {
            id: triggerId,
            teamId: assistant.teamId,
            workspaceId: assistant.workspaceId,
            assistantId: assistant.id,
            sourceKind: "member_message",
            payerUserId: ticket.payerUserId,
            authorUserId: caller.userId,
            dedupeKey: triggerId,
            text: `A member asked to retry "${ticket.title}".`,
            routedTicketId: ticket.id,
            status: "decided",
          });
        }
        return resetTicketFailuresRow(tx, { ticketId: ticket.id, now });
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      // Raced with another identical retry; the trigger is already there.
      created = false;
      updated = await resetTicketFailuresRow(db, { ticketId: ticket.id, now });
    }

    return { ticket: presentTicket(updated), created };
  }
}

export const assistantService = new AssistantService(
  assistantPorts,
  // Loaded lazily: the dispatch module pulls in the Router's tools and
  // rendering, which a plain read of the assistant never needs.
  // `kickAssistant` itself never throws; the import is inside the same
  // guard so a module that fails to load cannot turn a message that already
  // committed into a 500. The tick picks the message up either way.
  async (assistant) => {
    try {
      const { kickAssistant } = await import("./dispatch");
      await kickAssistant(assistant);
    } catch (error) {
      logger.error("Assistant kick could not run; the next tick will pick it up", {
        assistantId: assistant.assistantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
