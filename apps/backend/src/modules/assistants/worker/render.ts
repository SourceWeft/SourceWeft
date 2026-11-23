/**
 * The message a ticket's worker run starts with: the ticket itself and the
 * events delivered to it, framed the same way the Router reads its batch
 * (`router/render.ts`) — every piece of member- or model-written text sits
 * inside a tag and is escaped, and the block says tags are data.
 *
 * Pure (string formatting only), so the dispatch tick and its tests share
 * it without a database.
 */
import {
  DATA_NOT_INSTRUCTIONS_LINE,
  escapeTagText,
  renderTriggerLine,
  type RenderTrigger,
} from "../router/render";

/** What kind of delivery this run is. */
export type WorkerDeliveryKind =
  /** The ticket's first run. */
  | "initial"
  /** New events for a ticket that has run before. */
  | "append"
  /** Another try after a run that failed. */
  | "retry";

/** One delivered event, with the note the Router routed it with (its
 * `route_to_ticket` decision's `note`), when there is one. */
export type WorkerDeliveryTrigger = RenderTrigger & {
  routerNote?: string | null;
};

export type WorkerDeliveryInput = {
  kind: WorkerDeliveryKind;
  ticket: { id: string; title: string; goal: string };
  triggers: readonly WorkerDeliveryTrigger[];
  /** Failed runs in a row so far; shown on a retry. */
  consecutiveFailures: number;
};

export function renderTicketTag(ticket: WorkerDeliveryInput["ticket"]): string {
  return [
    `<assistant-ticket id=${ticket.id}>`,
    `Title: ${escapeTagText(ticket.title)}`,
    `Goal: ${escapeTagText(ticket.goal)}`,
    "</assistant-ticket>",
  ].join("\n");
}

const HEADINGS: Record<WorkerDeliveryKind, string> = {
  initial:
    "新工单。完成或卡住时调用 `report`。A new ticket. Call `report` when you finish or get stuck.",
  append:
    "这个工单有新内容。处理后调用 `report`。New input for this ticket. Call `report` once you have handled it.",
  retry:
    "上一次运行没有完成，请从停下的地方继续，然后调用 `report`。The previous run did not finish; continue where it stopped, then call `report`.",
};

/**
 * The Router's note for one delivered event: its instruction for this
 * delivery (what to rework, say). Its own element right after the event's
 * line, inside the same data block and escaped like everything else the
 * model wrote — without it, a report routed back for rework reaches the
 * worker as nothing but its own earlier report.
 */
function renderRouterNote(triggerId: string, note: string): string {
  return `<router-note for=${triggerId}>${escapeTagText(note)}</router-note>`;
}

export function renderWorkerDelivery(input: WorkerDeliveryInput): string {
  const lines: string[] = [HEADINGS[input.kind]];
  if (input.kind === "retry") {
    lines.push(
      `连续失败次数 / Failed runs in a row: ${input.consecutiveFailures}`,
    );
  }
  lines.push("", DATA_NOT_INSTRUCTIONS_LINE, "", renderTicketTag(input.ticket));
  if (input.triggers.length > 0) {
    lines.push("");
    for (const trigger of input.triggers) {
      lines.push(renderTriggerLine(trigger));
      if (trigger.routerNote)
        lines.push(renderRouterNote(trigger.id, trigger.routerNote));
    }
  }
  return lines.join("\n");
}
