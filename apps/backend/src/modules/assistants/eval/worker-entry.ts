/**
 * Worker process for the P1 evaluation only (#692, Task 10; never deployed,
 * never imported by production code). Starts the real worker
 * (`worker/main.ts`: queues, chat runs, the Router's real turn provider),
 * then swaps the `assistant_ticket` provider for one whose only tool, the
 * moment it is called, files the real `report` with status `ready`. The
 * evaluation measures the Router; a ticket's worker only has to finish fast
 * and leave the same trail a real one would (a `worker_report` event and a
 * `ticket_update` feed item), without doing any work.
 *
 * Run: pnpm --filter @sourceweft/backend exec tsx src/modules/assistants/eval/worker-entry.ts
 */
import "./require-eval-database";
import { tool } from "langchain";
import { z } from "zod";
import {
  registerOriginTurnProvider,
  unregisterOriginTurnProvider,
  type OriginTurnContext,
} from "../../threads/agent/origin-providers";
import { createReportTool, resolveWorkerToolsContext } from "../worker/tools";

// The production worker, unchanged: it registers both assistant providers.
await import("../../../worker/main");

const EVAL_WORKER_PROMPT = `Evaluation mode. This ticket is not really worked on. Call the \`finish\` tool exactly once, right away, with no arguments, then end the turn with one short sentence. Do nothing else.
评测模式：立即调用一次 \`finish\`（不带参数），然后用一句话结束本轮，不做其他任何事。`;

// Reads like a real worker's report: the Router sees it (as the ticket's
// last report and as a `worker_report` event), and a summary that says
// "not really done" would make it react to the evaluation, not the stream.
const EVAL_SUMMARY = "Done. The result is in this ticket's conversation.";

unregisterOriginTurnProvider("assistant_ticket");
registerOriginTurnProvider("assistant_ticket", {
  replaceTools: true,
  async tools(ctx: OriginTurnContext) {
    const report = createReportTool(await resolveWorkerToolsContext(ctx));
    const finish = tool(
      // The real report path, always `ready`. Invoked without the outer
      // call's config, so each call is its own report (no tool-call id).
      async () => report.invoke({ status: "ready", summary: EVAL_SUMMARY }),
      {
        name: "finish",
        description: "Mark this ticket done. Takes no arguments.",
        schema: z.object({}),
      },
    );
    return [finish];
  },
  async prompt(ctx: OriginTurnContext) {
    await resolveWorkerToolsContext(ctx);
    return EVAL_WORKER_PROMPT;
  },
});
