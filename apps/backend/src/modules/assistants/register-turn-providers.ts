/**
 * Wires the workspace assistant into turn assembly: one origin turn
 * provider per assistant conversation kind. Called once when the worker
 * process starts (`worker/main.ts`); the threads module never imports this
 * module, it only looks the providers up by a conversation's origin.
 *
 * Both providers read only their own keys from `hostContext` (set by the
 * dispatch tick) and load everything else from the database, and both fail
 * the turn — by throwing while it is being assembled, before the model sees
 * a tool — when a key is missing or names an assistant, batch or ticket that
 * is not there. Neither falls back to a default.
 */
import {
  registerOriginTurnProvider,
  type OriginTurnContext,
} from "../threads/agent/origin-providers";
import { assistantPorts, type AssistantPorts } from "./ports";
import { ROUTER_PROMPT } from "./router/prompt";
import { createRouterTools, resolveRouterToolsContext } from "./router/tools";
import { renderWorkerPrompt } from "./worker/prompt";
import { createReportTool, resolveWorkerToolsContext } from "./worker/tools";

export function registerAssistantTurnProviders(
  ports: AssistantPorts = assistantPorts,
): void {
  // The Router: its own tools only, deciding the batch named by
  // `hostContext.batchKey` (its events are read from the database).
  registerOriginTurnProvider("assistant_router", {
    replaceTools: true,
    async tools(ctx: OriginTurnContext) {
      return createRouterTools(await resolveRouterToolsContext(ctx), ports);
    },
    async prompt(ctx: OriginTurnContext) {
      // Resolved here too, so a prompt is never built for a batch that the
      // tools would refuse.
      await resolveRouterToolsContext(ctx);
      return ROUTER_PROMPT;
    },
  });

  // A ticket's worker: the turn's own read-only tools plus `report`.
  registerOriginTurnProvider("assistant_ticket", {
    replaceTools: false,
    async tools(ctx: OriginTurnContext) {
      return [createReportTool(await resolveWorkerToolsContext(ctx), ports)];
    },
    async prompt(ctx: OriginTurnContext) {
      const { ticket } = await resolveWorkerToolsContext(ctx);
      return renderWorkerPrompt(ticket);
    },
  });
}
