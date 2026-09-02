/**
 * The `plan` delegate — read-only architect (Claude's Plan).
 *
 * Shares Explore's read-only tool scope, but its job is different: investigate,
 * then return a structured plan (steps, key references, risks) rather than raw
 * findings. Read-only, so producing a plan never mutates workspace state.
 *
 * - **Read-only** — same deny-write scope as `explore`.
 * - **No `model` override** — inherits the parent's billed gateway model.
 * - **Explicit empty `interruptOn`** — no inherited HITL.
 */
import type { AnyBackendProtocol, SubAgent } from "deepagents";
import type { AgentMiddleware } from "langchain";
import { z } from "zod";
import {
  filterReadOnlyBusinessTools,
  readOnlyChildMiddleware,
} from "./read-only";

/** The `subagent_type` the model uses to select this delegate in `task`. */
export const PLAN_SUBAGENT_NAME = "plan";

export const planResponseSchema = z.object({
  summary: z
    .string()
    .describe("One-paragraph statement of the plan's objective and approach."),
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      keyReferences: z
        .array(z.string())
        .describe("Sources or working files this step depends on."),
    }),
  ),
  risks: z
    .array(z.string())
    .describe("Trade-offs, unknowns, or things that could go wrong."),
  openQuestions: z
    .array(z.string())
    .describe("What the caller must decide or clarify before executing."),
});

const PLAN_DESCRIPTION =
  "Read-only planning delegate. Launch it to turn a complex, open-ended request " +
  "into a concrete, step-by-step plan grounded in the thread's sources and " +
  "working files. It investigates read-only (search sources, read files) but " +
  "cannot write, execute, or publish — it proposes, it does not act. Give it the " +
  "full objective; it replies with one structured plan and its messages are not " +
  "shown to the user.";

const PLAN_SYSTEM_PROMPT = [
  "You are a planning delegate operating in an isolated context window.",
  "",
  "Your job is to investigate the objective read-only, then return a single,",
  "self-contained plan. You have read-only tools: search the thread's sources and",
  "read working files. You cannot write files, run commands, or publish, and you",
  "do not execute the plan — you design it.",
  "",
  "Investigate only as much as the plan needs, then stop. In your structured",
  "response, give a concise objective/approach summary; ordered steps, each with a",
  "title, actionable detail, and the key sources/files it depends on; explicit",
  "risks and trade-offs; and open questions the caller must decide before",
  "executing. The caller sees only that response, so make it self-contained.",
].join("\n");

/**
 * Build the `plan` delegate definition. Read-only architect: same tool scope as
 * `explore`, inherited billed model, no HITL.
 *
 * No `responseFormat`: the delegate investigates read-only and produces free-text
 * findings. The structured {@link planResponseSchema} plan is produced by a
 * dedicated `model.withStructuredOutput(...).invoke(...)` call after the agent
 * finishes. Inline `responseFormat` binds
 * the schema as an auto tool each loop, which is ~50% unreliable on DeepSeek (the
 * model answers text instead of calling it → GraphRecursionError); one dedicated
 * structured call is DeepSeek-safe.
 *
 * @param input - Bound business tools, shared backend, and child governance.
 * @returns A seam-shaped {@link SubAgent} definition for the `task` tool.
 */
export function createPlanSubagent(input: {
  availableTools: readonly { readonly name: string }[];
  backend: AnyBackendProtocol;
  middleware: readonly AgentMiddleware[];
}): SubAgent {
  return {
    name: PLAN_SUBAGENT_NAME,
    description: PLAN_DESCRIPTION,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    tools: filterReadOnlyBusinessTools(
      input.availableTools,
    ) as unknown as SubAgent["tools"],
    middleware: readOnlyChildMiddleware({
      backend: input.backend,
      middleware: input.middleware,
    }),
    interruptOn: {},
  };
}
