/**
 * The `explore` delegate — read-only investigation (Claude's Explore).
 *
 * Delegation via deepagents' `task` tool is context quarantine: a noisy
 * sub-investigation (searching across sources, reading many files) burns the
 * *child's* context window and returns a single distilled report, keeping the
 * parent turn clean. The shared filesystem backend is the parent↔child
 * blackboard; conversation messages stay isolated.
 *
 * - **Read-only** — searches sources and reads working files, never writes,
 *   executes, or publishes (see {@link READ_ONLY_FILESYSTEM_PERMISSIONS}).
 * - **No `model` override** — inherits the parent's billed gateway model, so
 *   every child model call settles against the same billing scope.
 * - **Explicit empty `interruptOn`** — Deep Agents otherwise falls back to the
 *   parent's HITL config even for a custom child.
 */
import type { AnyBackendProtocol, SubAgent } from "deepagents";
import type { AgentMiddleware } from "langchain";
import { z } from "zod";
import {
  filterReadOnlyBusinessTools,
  readOnlyChildMiddleware,
} from "./read-only";

/** The `subagent_type` the model uses to select this delegate in `task`. */
export const EXPLORE_SUBAGENT_NAME = "explore";

export const exploreResponseSchema = z.object({
  summary: z.string().describe("Concise answer to the delegated question."),
  findings: z.array(
    z.object({
      claim: z.string(),
      citationMarkers: z.array(z.string()),
      sourceReferences: z.array(z.string()),
    }),
  ),
  limitations: z.array(z.string()),
});

const EXPLORE_DESCRIPTION =
  "Read-only investigation delegate for complex, multi-step lookups across the " +
  "thread's sources and working files. Launch it when gathering evidence would " +
  "otherwise fill the main context with search and file-reading noise. It can " +
  "search sources and read files but cannot write, execute, or publish. Give it " +
  "the full question and state exactly what to return; it replies with one " +
  "distilled report and its messages are not shown to the user.";

const EXPLORE_SYSTEM_PROMPT = [
  "You are a focused investigation delegate operating in an isolated context window.",
  "",
  "Your job is to gather and synthesize evidence for the task you are given, then",
  "return a single, self-contained report. You have read-only tools: search the",
  "thread's sources and read working files. You cannot write files, run commands,",
  "or publish — do not claim to have done so.",
  "",
  "Work efficiently: search and read only what the task needs, then stop. In your",
  "structured response, include a concise summary; findings with claim, current",
  "citation markers, and source/file references; and explicit limitations for",
  "anything you could not verify. The caller sees only that response, so make it",
  "self-contained.",
].join("\n");

/**
 * Build the `explore` delegate definition. Read-only tools only; `model` is
 * omitted so the billed parent model is inherited; `interruptOn` is explicitly
 * empty so Deep Agents cannot inherit parent HITL.
 *
 * @param input - Bound business tools, shared backend, and child governance.
 * @returns A seam-shaped {@link SubAgent} definition for the `task` tool.
 */
export function createExploreSubagent(input: {
  availableTools: readonly { readonly name: string }[];
  backend: AnyBackendProtocol;
  middleware: readonly AgentMiddleware[];
}): SubAgent {
  return {
    name: EXPLORE_SUBAGENT_NAME,
    description: EXPLORE_DESCRIPTION,
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    tools: filterReadOnlyBusinessTools(
      input.availableTools,
    ) as unknown as SubAgent["tools"],
    middleware: readOnlyChildMiddleware({
      backend: input.backend,
      middleware: input.middleware,
    }),
    interruptOn: {},
    responseFormat: exploreResponseSchema,
  };
}
