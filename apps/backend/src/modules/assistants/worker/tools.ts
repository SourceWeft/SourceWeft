/**
 * The Worker's own tool: `report`, how a ticket's worker run says where the
 * ticket stands (done, waiting on a person, stuck, failed, no longer
 * needed). Everything else a worker run uses is the turn's own read-only
 * roster; this is added on top (`replaceTools: false`).
 *
 * Like the Router's tools (`router/tools.ts`), `report` never throws once the
 * turn is running: a refusal or an unexpected error comes back as an
 * ordinary tool result. A thrown tool error takes down the turn — and the
 * process — under the LangChain v3 stream.
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
  findScopedTicketRow,
  insertFeedItemRow,
  insertTriggerRow,
  uniqueViolation,
  updateScopedTicketRow,
  type AssistantTicketRow,
} from "../repository";

export type WorkerToolsContext = OriginTurnContext & {
  assistantId: string;
  ticketId: string;
};

export type WorkerToolError = {
  type: "assistant_worker_tool_error";
  code: string;
  message: string;
};

function toolError(code: string, message: string): WorkerToolError {
  return { type: "assistant_worker_tool_error", code, message };
}

export function isWorkerToolError(value: unknown): value is WorkerToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "assistant_worker_tool_error"
  );
}

/** What the notification about a ticket points at. */
export const ASSISTANT_TICKET_REF = "assistant_ticket";

/**
 * Resolves a plain `OriginTurnContext` into what `createReportTool` needs.
 * `hostContext` carries only `assistantId` and `ticketId` (set by the
 * dispatch tick); both must be there and name an assistant of this
 * workspace and one of its tickets. Anything else throws: this runs once, at
 * turn setup, before the model sees a tool, so throwing means the turn never
 * starts rather than running without its ticket.
 */
export async function resolveWorkerToolsContext(
  ctx: OriginTurnContext,
): Promise<WorkerToolsContext & { ticket: AssistantTicketRow }> {
  const assistantId = ctx.hostContext.assistantId;
  const ticketId = ctx.hostContext.ticketId;
  if (!assistantId || !ticketId) {
    throw new Error(
      "The Worker turn's hostContext is missing assistantId or ticketId.",
    );
  }
  const assistant = await findAssistantRow({
    workspaceId: ctx.workspaceId,
    teamId: ctx.teamId,
  });
  if (!assistant || assistant.id !== assistantId) {
    throw new Error(`No assistant '${assistantId}' in this workspace.`);
  }
  const ticket = await findScopedTicketRow({
    assistantId,
    teamId: ctx.teamId,
    workspaceId: ctx.workspaceId,
    ticketId,
  });
  if (!ticket) {
    throw new Error(`No ticket '${ticketId}' for assistant '${assistantId}'.`);
  }
  return { ...ctx, assistantId, ticketId, ticket };
}

export const WORKER_REPORT_STATUSES = [
  "ready",
  "waiting",
  "blocked",
  "failed",
  "dropped",
] as const;
export type WorkerReportStatus = (typeof WORKER_REPORT_STATUSES)[number];

const REPORT_SUMMARY_MAX = 2000;
const REPORT_QUESTION_MAX = 500;

const reportSchema = z.object({
  status: z.enum(WORKER_REPORT_STATUSES),
  summary: z.string().trim().min(1).max(REPORT_SUMMARY_MAX),
  question: z.string().trim().min(1).max(REPORT_QUESTION_MAX).optional(),
});

/** Done or no longer needed: the ticket rests. Anything else needs a person. */
function stageAfterReport(status: WorkerReportStatus) {
  return status === "ready" || status === "dropped" ? "idle" : "waiting_person";
}

/** The `worker_report` event's text: `status: summary`, plus the question. */
export function workerReportText(input: {
  status: WorkerReportStatus;
  summary: string;
  question?: string;
}): string {
  const base = `${input.status}: ${input.summary}`;
  return input.question ? `${base}\nQuestion: ${input.question}` : base;
}

function capFeedText(text: string): string {
  const max = ASSISTANT_LIMITS.feedMessageMax;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toolCallIdOf(config: unknown): string | null {
  const id = (config as { toolCall?: { id?: unknown } } | undefined)?.toolCall
    ?.id;
  return typeof id === "string" && id ? id : null;
}

export function createReportTool(
  ctx: WorkerToolsContext,
  ports: AssistantPorts = assistantPorts,
) {
  return tool(
    async (args: z.infer<typeof reportSchema>, config?: unknown) => {
      try {
        return await report(ctx, ports, args, toolCallIdOf(config));
      } catch (error) {
        logger.error("Worker report failed", {
          ticketId: ctx.ticketId,
          runId: ctx.runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return toolError(
          "REPORT_FAILED",
          error instanceof Error && error.message
            ? error.message
            : "The report could not be saved.",
        );
      }
    },
    {
      name: "report",
      description:
        "Report where this ticket stands. Call it when you finish or get stuck. status: ready (done), waiting (needs a person's answer; put it in question), blocked (stuck), failed, dropped (no longer needed). summary: what you did and where the result is (at most 2000 characters). question: one question for the member paying for this ticket (at most 500 characters); they are notified. 报告工单进展：完成或卡住时必须调用。",
      schema: reportSchema,
    },
  );
}

async function report(
  ctx: WorkerToolsContext,
  ports: AssistantPorts,
  args: z.infer<typeof reportSchema>,
  toolCallId: string | null,
) {
  const scope = {
    assistantId: ctx.assistantId,
    teamId: ctx.teamId,
    workspaceId: ctx.workspaceId,
    ticketId: ctx.ticketId,
  };
  // One event per tool call: a replayed call (same id) is absorbed by the
  // trigger's unique key. Without a call id, every call is its own report.
  const triggerId = deterministicId(
    "assistant-worker-report",
    ctx.ticketId,
    ctx.runId,
    toolCallId ?? randomUUID(),
  );
  const text = workerReportText(args);
  const now = new Date();

  let written: AssistantTicketRow | WorkerToolError;
  try {
    written = await db.transaction(async (tx) => {
      const ticket = await findScopedTicketRow(scope, tx, { forUpdate: true });
      if (!ticket) {
        return toolError("TICKET_NOT_FOUND", "This ticket no longer exists.");
      }
      if (ticket.stage === "ended") {
        return toolError(
          "TICKET_ENDED",
          "This ticket was closed; there is nothing left to report on.",
        );
      }
      // The dispatch tick writes `current_run_id` right after starting this
      // run, so it can still be empty when a quick run reports; a different
      // run id means this run is no longer the ticket's.
      if (ticket.currentRunId && ticket.currentRunId !== ctx.runId) {
        return toolError(
          "STALE_RUN",
          "This run is no longer the one working on this ticket; the report was not saved.",
        );
      }
      await insertTriggerRow(tx, {
        id: triggerId,
        teamId: ctx.teamId,
        workspaceId: ctx.workspaceId,
        assistantId: ctx.assistantId,
        sourceKind: "worker_report",
        payerUserId: ticket.payerUserId,
        authorUserId: null,
        dedupeKey: triggerId,
        text,
        ticketId: ticket.id,
        status: "pending_eval",
      });
      const updated = await updateScopedTicketRow(tx, scope, {
        stage: stageAfterReport(args.status),
        outcome: args.status,
        blockedReason: null,
        lastReportSummary: args.summary,
        updatedAt: now,
      });
      await insertFeedItemRow(tx, {
        id: deterministicId("assistant-feed-worker-report", triggerId),
        teamId: ctx.teamId,
        workspaceId: ctx.workspaceId,
        assistantId: ctx.assistantId,
        kind: "ticket_update",
        text: capFeedText(`${ticket.title}: ${text}`),
        triggerId,
        ticketId: ticket.id,
      });
      return updated!;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      return { ok: true as const, alreadyReported: true };
    }
    throw error;
  }
  if (isWorkerToolError(written)) return written;

  let notified = false;
  if (args.question) {
    try {
      await ports.notify({
        kind: "assistant_question",
        teamId: ctx.teamId,
        userId: written.payerUserId,
        ref: { kind: ASSISTANT_TICKET_REF, id: written.id },
        payload: {
          assistantId: ctx.assistantId,
          ticketId: written.id,
          taskName: written.title,
        },
      });
      notified = true;
    } catch (error) {
      // The report is saved either way; the question is in the feed.
      logger.error("Failed to notify the payer of a worker's question", {
        ticketId: written.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: true as const, stage: written.stage, notified };
}
