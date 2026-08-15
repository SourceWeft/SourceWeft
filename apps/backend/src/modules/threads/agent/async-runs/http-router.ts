/**
 * Agent-Protocol / LangGraph-Server route handlers for the async-runs endpoint.
 *
 * These are the exact operations deepagents' `createAsyncSubAgentMiddleware`
 * invokes through the langgraph-sdk `Client`. Handlers are pure `(store, params,
 * body) → { status, body }` functions so they can be unit-tested against the
 * in-memory store; the HTTP framework layer (routing, auth, JSON) is a thin
 * wrapper added separately.
 *
 * Wire shapes are snake_case per the Agent Protocol; `assistant_id` carries the
 * delegate graph id (deepagents' `AsyncSubAgent.graphId`).
 */
import type { MultitaskStrategy, RunRecord, RunsStore, ThreadRecord } from "./types";
import { RunConflictError } from "./in-memory-store";

export interface HandlerResult {
  status: number;
  body: unknown;
}

const MULTITASK_STRATEGIES: ReadonlySet<string> = new Set([
  "reject",
  "interrupt",
  "rollback",
  "enqueue",
]);

function runToWire(run: RunRecord) {
  return {
    run_id: run.runId,
    thread_id: run.threadId,
    assistant_id: run.graphId,
    status: run.status,
    multitask_strategy: run.multitaskStrategy,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function threadToWire(thread: ThreadRecord) {
  return { thread_id: thread.threadId, created_at: thread.createdAt };
}

/** Parse a create-run body: `assistant_id` (required) + `multitask_strategy`. */
export function parseCreateRunBody(
  body: unknown,
): { assistantId: string; multitaskStrategy: MultitaskStrategy } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const assistantId = record.assistant_id;
  if (typeof assistantId !== "string" || assistantId.trim().length === 0) {
    return null;
  }
  const raw = record.multitask_strategy;
  // The Agent Protocol default is "reject"; deepagents' update path sends
  // "interrupt" explicitly.
  const multitaskStrategy: MultitaskStrategy =
    typeof raw === "string" && MULTITASK_STRATEGIES.has(raw)
      ? (raw as MultitaskStrategy)
      : "reject";
  return { assistantId: assistantId.trim(), multitaskStrategy };
}

export async function handleCreateThread(
  store: RunsStore,
): Promise<HandlerResult> {
  return { status: 201, body: threadToWire(await store.createThread()) };
}

export async function handleCreateRun(
  store: RunsStore,
  threadId: string,
  body: unknown,
): Promise<HandlerResult> {
  const parsed = parseCreateRunBody(body);
  if (!parsed) {
    return { status: 400, body: { error: "invalid create-run body" } };
  }
  try {
    const run = await store.createRun({
      threadId,
      graphId: parsed.assistantId,
      multitaskStrategy: parsed.multitaskStrategy,
    });
    return { status: 201, body: runToWire(run) };
  } catch (error) {
    if (error instanceof RunConflictError) {
      return {
        status: 409,
        body: { error: error.message, active_run_id: error.activeRunId },
      };
    }
    throw error;
  }
}

export async function handleGetRun(
  store: RunsStore,
  threadId: string,
  runId: string,
): Promise<HandlerResult> {
  const run = await store.getRun(threadId, runId);
  return run
    ? { status: 200, body: runToWire(run) }
    : { status: 404, body: { error: "run not found" } };
}

export async function handleListRuns(
  store: RunsStore,
  threadId: string,
): Promise<HandlerResult> {
  const runs = await store.listRuns(threadId);
  return { status: 200, body: runs.map(runToWire) };
}

export async function handleCancelRun(
  store: RunsStore,
  threadId: string,
  runId: string,
): Promise<HandlerResult> {
  const run = await store.cancelRun(threadId, runId);
  return run
    ? { status: 200, body: runToWire(run) }
    : { status: 404, body: { error: "run not found" } };
}

export async function handleGetThreadState(
  store: RunsStore,
  threadId: string,
): Promise<HandlerResult> {
  return { status: 200, body: { values: await store.getThreadState(threadId) } };
}
