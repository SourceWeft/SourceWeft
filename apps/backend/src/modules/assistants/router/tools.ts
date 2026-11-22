/**
 * The Router's own tools: decide every event in its batch
 * (`create_ticket`/`route_to_ticket`/`ignore`), talk to the shared feed
 * (`say`), and look something up (`recall`).
 *
 * Every tool body is wrapped in `guarded`: nothing it does is ever allowed
 * to throw past the tool call, including a business-rule refusal (an id
 * outside the batch, another assistant's ticket, an already-decided
 * trigger). A thrown error from inside a tool call is a known way to take
 * down the whole turn — and the API process — under the LangChain v3 stream
 * (see memory: v3-tool-error-process-crash), so every failure here comes
 * back as an ordinary tool result the model can read and act on instead.
 */
import { randomUUID } from "node:crypto";
import { tool } from "langchain";
import { z } from "zod";
import { db } from "@sourceweft/db";
import type { OriginTurnContext } from "../../threads/agent/origin-providers";
import { deterministicId } from "../../agent-tasks/runs";
import { logger } from "../../../shared/logger";
import { ASSISTANT_LIMITS } from "../limits";
import { assistantPorts, type AssistantPorts } from "../ports";
import {
  findAssistantRow,
  findFeedItemRowsByIdPrefix,
  findTicketRow,
  findTicketRowsByIdPrefix,
  findTriggerRowsByIdPrefix,
  findTriggerRowsByIds,
  findTriggerRowsRoutedToTicket,
  insertDecisionRow,
  insertFeedItemRow,
  insertTicketRow,
  markTriggersDecidedRows,
  type AssistantTicketRow,
  type AssistantTriggerRow,
} from "../repository";

export type RouterToolsContext = OriginTurnContext & {
  assistantId: string;
  batchKey: string;
  batchTriggerIds: string[];
};

export type RouterToolError = {
  type: "assistant_router_tool_error";
  code: string;
  message: string;
};

function toolError(code: string, message: string): RouterToolError {
  return { type: "assistant_router_tool_error", code, message };
}

export function isRouterToolError(value: unknown): value is RouterToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "assistant_router_tool_error"
  );
}

/**
 * Runs one Router tool body, turning any thrown error into a tool-error
 * result rather than letting it propagate — see the file header. Business
 * refusals do not throw at all (they `return toolError(...)` directly), so
 * this is really only a backstop for the unexpected (a DB error, say).
 */
async function guarded<T>(
  toolName: string,
  run: () => Promise<T | RouterToolError>,
): Promise<T | RouterToolError> {
  try {
    return await run();
  } catch (error) {
    logger.error("Router tool failed", {
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return toolError(
      "ROUTER_TOOL_FAILED",
      error instanceof Error && error.message
        ? error.message
        : "The tool failed.",
    );
  }
}

function outsideBatchError(ids: readonly string[]): RouterToolError {
  return toolError(
    "TRIGGER_NOT_IN_BATCH",
    `Not in this batch: ${ids.join(", ")}. Only triggerIds from this batch (see the <assistant-trigger> ids) can be acted on.`,
  );
}

/** `triggerIds` validated against the batch, then loaded and checked to
 * still be `in_eval` (not already decided by an earlier call this run). */
async function loadBatchTriggers(
  ctx: RouterToolsContext,
  triggerIds: readonly string[],
): Promise<AssistantTriggerRow[] | RouterToolError> {
  const batchSet = new Set(ctx.batchTriggerIds);
  const outside = triggerIds.filter((id) => !batchSet.has(id));
  if (outside.length > 0) return outsideBatchError(outside);

  const rows = await findTriggerRowsByIds({
    ids: [...triggerIds],
    teamId: ctx.teamId,
    workspaceId: ctx.workspaceId,
    assistantId: ctx.assistantId,
  });
  const found = new Set(rows.map((row) => row.id));
  const missing = triggerIds.filter((id) => !found.has(id));
  if (missing.length > 0) return outsideBatchError(missing);

  const alreadyDecided = rows.filter((row) => row.status !== "in_eval");
  if (alreadyDecided.length > 0) {
    return toolError(
      "TRIGGER_ALREADY_DECIDED",
      `Already decided this run: ${alreadyDecided.map((row) => row.id).join(", ")}.`,
    );
  }
  return rows;
}

/** A ticket id scoped to this assistant — another assistant's ticket (or an
 * unknown id) resolves to the same "not found" refusal. */
async function loadOwnTicket(
  ctx: RouterToolsContext,
  ticketId: string,
): Promise<AssistantTicketRow | RouterToolError> {
  const ticket = await findTicketRow({ ticketId, assistantId: ctx.assistantId });
  if (!ticket) {
    return toolError(
      "TICKET_NOT_FOUND",
      `No ticket '${ticketId}' for this assistant.`,
    );
  }
  return ticket;
}

const createTicketSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(2000),
  triggerIds: z.array(z.string().min(1)).min(1),
});

const routeToTicketSchema = z.object({
  ticketId: z.string().min(1),
  triggerIds: z.array(z.string().min(1)).min(1),
  note: z.string().trim().max(2000).optional(),
});

const ignoreSchema = z.object({
  triggerIds: z.array(z.string().min(1)).min(1),
  reason: z.string().trim().min(1).max(200),
});

const saySchema = z.object({
  text: z.string().trim().min(1).max(ASSISTANT_LIMITS.routerSayMaxChars),
  replyToTriggerId: z.string().min(1).optional(),
});

const recallSchema = z.object({
  id: z.string().min(1),
});

/**
 * Resolves a plain `OriginTurnContext` into what `createRouterTools` needs,
 * reading `assistantId`/`batchKey`/`batchTriggerIds` out of `hostContext`
 * (set by whoever starts this host turn — Task 7's scheduler tick, via
 * `startHostTurn`'s own `hostContext`) and loading the assistant row.
 *
 * Throws when any of that is missing, malformed, or the assistant does not
 * exist — but this runs once, at turn *setup*, before the model ever sees a
 * tool: throwing here means the turn never starts, which is the right
 * failure mode (contrast with the tools themselves in this file, which must
 * never throw once the turn is running).
 */
export async function resolveRouterToolsContext(
  ctx: OriginTurnContext,
): Promise<RouterToolsContext> {
  const assistantId = ctx.hostContext.assistantId;
  const batchKey = ctx.hostContext.batchKey;
  const batchTriggerIdsRaw = ctx.hostContext.batchTriggerIds;
  if (!assistantId || !batchKey || !batchTriggerIdsRaw) {
    throw new Error(
      "The Router turn's hostContext is missing assistantId, batchKey, or batchTriggerIds.",
    );
  }
  let batchTriggerIds: unknown;
  try {
    batchTriggerIds = JSON.parse(batchTriggerIdsRaw);
  } catch {
    batchTriggerIds = undefined;
  }
  if (
    !Array.isArray(batchTriggerIds) ||
    batchTriggerIds.some((id) => typeof id !== "string")
  ) {
    throw new Error(
      "The Router turn's hostContext.batchTriggerIds is not a JSON array of strings.",
    );
  }
  const assistant = await findAssistantRow({
    workspaceId: ctx.workspaceId,
    teamId: ctx.teamId,
  });
  if (!assistant || assistant.id !== assistantId) {
    throw new Error(`No assistant '${assistantId}' in this workspace.`);
  }
  return { ...ctx, assistantId, batchKey, batchTriggerIds };
}

/**
 * Builds the Router's tool roster for one batch. `ports` defaults to the
 * production wiring; tests (and Task 7, until it has its own reason not to)
 * pass the fixture's fake ports instead, the same pattern `AssistantService`
 * uses.
 */
export function createRouterTools(
  ctx: RouterToolsContext,
  ports: AssistantPorts = assistantPorts,
) {
  const createTicket = tool(
    async (args: z.infer<typeof createTicketSchema>) =>
      guarded("create_ticket", async () => {
        const triggers = await loadBatchTriggers(ctx, args.triggerIds);
        if (isRouterToolError(triggers)) return triggers;

        const payerUserId = triggers[0]!.payerUserId;
        if (!payerUserId || triggers.some((t) => t.payerUserId !== payerUserId)) {
          return toolError(
            "TRIGGER_PAYER_MISMATCH",
            "These triggers do not share one payer; create_ticket needs triggers from a single payer's batch.",
          );
        }

        const ticketId = randomUUID();
        const now = new Date();
        const workerThreadId = deterministicId(
          "assistant-ticket-thread",
          ticketId,
        );
        await db.transaction(async (tx) => {
          await insertTicketRow(tx, {
            id: ticketId,
            teamId: ctx.teamId,
            workspaceId: ctx.workspaceId,
            assistantId: ctx.assistantId,
            workerThreadId,
            title: args.title,
            goal: args.goal,
            payerUserId,
            creditCap: ASSISTANT_LIMITS.ticketCreditCapDefault,
            now,
          });
          for (const trigger of triggers) {
            await insertDecisionRow(tx, {
              id: deterministicId(
                "assistant-decision",
                trigger.id,
                ctx.batchKey,
              ),
              teamId: ctx.teamId,
              workspaceId: ctx.workspaceId,
              assistantId: ctx.assistantId,
              triggerId: trigger.id,
              routerBatchKey: ctx.batchKey,
              action: "create_ticket",
              ticketId,
            });
          }
          await markTriggersDecidedRows(tx, {
            ids: triggers.map((t) => t.id),
            assistantId: ctx.assistantId,
            routedTicketId: ticketId,
          });
          await insertFeedItemRow(tx, {
            id: deterministicId("assistant-feed-ticket-created", ticketId),
            teamId: ctx.teamId,
            workspaceId: ctx.workspaceId,
            assistantId: ctx.assistantId,
            kind: "ticket_update",
            text: `New ticket: ${args.title}`,
            ticketId,
          });
        });
        return { ticketId };
      }),
    {
      name: "create_ticket",
      description:
        "Create a new ticket from one or more events in this batch and assign it a worker. 为批次中的一个或多个事件创建新工单。triggerIds must all be from this batch and share one payer.",
      schema: createTicketSchema,
    },
  );

  const routeToTicket = tool(
    async (args: z.infer<typeof routeToTicketSchema>) =>
      guarded("route_to_ticket", async () => {
        const ticket = await loadOwnTicket(ctx, args.ticketId);
        if (isRouterToolError(ticket)) return ticket;
        const triggers = await loadBatchTriggers(ctx, args.triggerIds);
        if (isRouterToolError(triggers)) return triggers;

        await db.transaction(async (tx) => {
          for (const trigger of triggers) {
            await insertDecisionRow(tx, {
              id: deterministicId(
                "assistant-decision",
                trigger.id,
                ctx.batchKey,
              ),
              teamId: ctx.teamId,
              workspaceId: ctx.workspaceId,
              assistantId: ctx.assistantId,
              triggerId: trigger.id,
              routerBatchKey: ctx.batchKey,
              action: "route_to_ticket",
              ticketId: ticket.id,
              reason: args.note ?? null,
            });
          }
          await markTriggersDecidedRows(tx, {
            ids: triggers.map((t) => t.id),
            assistantId: ctx.assistantId,
            routedTicketId: ticket.id,
          });
        });
        return { ticketId: ticket.id };
      }),
    {
      name: "route_to_ticket",
      description:
        "Route one or more events in this batch to an existing ticket, with a short note for whoever works it. 把事件路由到一个已有工单。triggerIds must all be from this batch; ticketId must belong to this assistant.",
      schema: routeToTicketSchema,
    },
  );

  const ignore = tool(
    async (args: z.infer<typeof ignoreSchema>) =>
      guarded("ignore", async () => {
        const triggers = await loadBatchTriggers(ctx, args.triggerIds);
        if (isRouterToolError(triggers)) return triggers;

        await db.transaction(async (tx) => {
          for (const trigger of triggers) {
            await insertDecisionRow(tx, {
              id: deterministicId(
                "assistant-decision",
                trigger.id,
                ctx.batchKey,
              ),
              teamId: ctx.teamId,
              workspaceId: ctx.workspaceId,
              assistantId: ctx.assistantId,
              triggerId: trigger.id,
              routerBatchKey: ctx.batchKey,
              action: "ignore",
              reason: args.reason,
            });
          }
          await markTriggersDecidedRows(tx, {
            ids: triggers.map((t) => t.id),
            assistantId: ctx.assistantId,
            routedTicketId: null,
          });
        });
        return { ignored: triggers.length };
      }),
    {
      name: "ignore",
      description:
        "Decide one or more events in this batch need no ticket and no reply. 忽略批次中不需要工单也不需要回复的事件，必须给出原因。",
      schema: ignoreSchema,
    },
  );

  const say = tool(
    async (args: z.infer<typeof saySchema>) =>
      guarded("say", async () => {
        let replyTrigger: AssistantTriggerRow | null = null;
        if (args.replyToTriggerId) {
          if (!ctx.batchTriggerIds.includes(args.replyToTriggerId)) {
            return outsideBatchError([args.replyToTriggerId]);
          }
          const rows = await findTriggerRowsByIds({
            ids: [args.replyToTriggerId],
            teamId: ctx.teamId,
            workspaceId: ctx.workspaceId,
            assistantId: ctx.assistantId,
          });
          replyTrigger = rows[0] ?? null;
          if (!replyTrigger) return outsideBatchError([args.replyToTriggerId]);
        }

        const feedId = deterministicId(
          "assistant-feed-router-say",
          ctx.batchKey,
          randomUUID(),
        );
        await db.transaction(async (tx) =>
          insertFeedItemRow(tx, {
            id: feedId,
            teamId: ctx.teamId,
            workspaceId: ctx.workspaceId,
            assistantId: ctx.assistantId,
            kind: "router_message",
            text: args.text,
            triggerId: replyTrigger?.id ?? null,
          }),
        );

        if (
          replyTrigger &&
          replyTrigger.sourceKind === "member_message" &&
          replyTrigger.authorUserId
        ) {
          await ports.notify({
            kind: "assistant_reply",
            teamId: ctx.teamId,
            userId: replyTrigger.authorUserId,
            email: false,
            ref: { kind: "assistant_feed_item", id: feedId },
            payload: { assistantId: ctx.assistantId },
          });
        }

        return { ok: true as const };
      }),
    {
      name: "say",
      description:
        "Write one short message (at most 100 words) to the assistant's shared feed. Optionally reply to one event from this batch — if it is a member message, its author is notified. 向共享动态写一条不超过100词的消息，可选回复批次中的一个事件（成员消息会收到通知）。",
      schema: saySchema,
    },
  );

  const recall = tool(
    async (args: z.infer<typeof recallSchema>) =>
      guarded("recall", async () => recallById(ctx, args.id)),
    {
      name: "recall",
      description:
        "Look up a ticket, event, or feed item by its id (a prefix is enough), and get its full text plus the ids and one-line summaries of what it is linked to. 按 id（前缀即可）查工单、事件或动态，返回全文及关联对象。",
      schema: recallSchema,
    },
  );

  return [createTicket, routeToTicket, ignore, say, recall];
}

const RECALL_CANDIDATE_LIMIT = 5;

type RecallMatch = {
  kind: "ticket" | "trigger" | "feed_item";
  id: string;
  text: string;
  related: Array<{ id: string; summary: string }>;
};

async function recallById(
  ctx: RouterToolsContext,
  idPrefix: string,
): Promise<RecallMatch | RouterToolError> {
  const [tickets, triggers, feedItems] = await Promise.all([
    findTicketRowsByIdPrefix({
      assistantId: ctx.assistantId,
      prefix: idPrefix,
      limit: RECALL_CANDIDATE_LIMIT,
    }),
    findTriggerRowsByIdPrefix({
      assistantId: ctx.assistantId,
      teamId: ctx.teamId,
      workspaceId: ctx.workspaceId,
      prefix: idPrefix,
      limit: RECALL_CANDIDATE_LIMIT,
    }),
    findFeedItemRowsByIdPrefix({
      assistantId: ctx.assistantId,
      teamId: ctx.teamId,
      workspaceId: ctx.workspaceId,
      prefix: idPrefix,
      limit: RECALL_CANDIDATE_LIMIT,
    }),
  ]);

  const totalMatches = tickets.length + triggers.length + feedItems.length;
  if (totalMatches === 0) {
    return toolError("RECALL_NOT_FOUND", `Nothing matches id '${idPrefix}'.`);
  }
  if (totalMatches > 1) {
    return toolError(
      "RECALL_AMBIGUOUS",
      `'${idPrefix}' matches more than one item. Use a longer, more specific id.`,
    );
  }

  if (tickets.length === 1) {
    const ticket = tickets[0]!;
    const routedTriggers = await findTriggerRowsRoutedToTicket({
      assistantId: ctx.assistantId,
      ticketId: ticket.id,
      limit: RECALL_CANDIDATE_LIMIT,
    });
    return {
      kind: "ticket",
      id: ticket.id,
      text: `${ticket.title}\n\n${ticket.goal}`,
      related: routedTriggers.map((trigger) => ({
        id: trigger.id,
        summary: oneLineSummary(trigger.text),
      })),
    };
  }

  if (triggers.length === 1) {
    const trigger = triggers[0]!;
    return {
      kind: "trigger",
      id: trigger.id,
      text: trigger.text,
      related: trigger.routedTicketId
        ? [{ id: trigger.routedTicketId, summary: "routed ticket" }]
        : [],
    };
  }

  const feedItem = feedItems[0]!;
  const related: Array<{ id: string; summary: string }> = [];
  if (feedItem.ticketId) related.push({ id: feedItem.ticketId, summary: "ticket" });
  if (feedItem.triggerId) related.push({ id: feedItem.triggerId, summary: "trigger" });
  return {
    kind: "feed_item",
    id: feedItem.id,
    text: feedItem.text,
    related,
  };
}

function oneLineSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`;
}
