import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ContentError } from "../../../content/errors";
import {
  readAgentStepBudgetForRefresh,
  type AgentStepBudgetState,
} from "../middleware/step-budget";
import { readAgentPartialTasksForRefresh } from "../middleware/closing-tool-governance";
import type { AgentRunnableConfig } from "./checkpoint";
import type { AgentCheckpointRef } from "../../turn/types";

type Scope = AgentStepBudgetState["scopes"][string];
function isV2(scope: Scope): scope is Extract<Scope, { policyVersion: 2 }> {
  return "policyVersion" in scope && scope.policyVersion === 2;
}
export type RefreshBudgetAgent = {
  getStateHistory(
    config: AgentRunnableConfig,
    options: { limit: number; before?: AgentRunnableConfig },
  ): AsyncIterable<unknown>;
  updateState(
    config: AgentRunnableConfig,
    update: Record<string, unknown>,
  ): Promise<unknown>;
};
const PAGE_SIZE = 128;
import {
  MAX_AGENT_REFRESH_GRAPH_ORIGINS,
  MAX_AGENT_REFRESH_HISTORY_CHECKPOINTS,
} from "../../agent-run-budget-limits";
function unavailable(cause?: unknown): never {
  const error = new ContentError(
    409,
    "AGENT_STEP_REFRESH_UNAVAILABLE",
    "Saved execution budget cannot be verified. Send a new message to continue.",
  );
  if (cause)
    Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  throw error;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** A rollback cannot recreate an unreturned child's private execution state. */
function assertNoUnreturnedRootDelegate(state: unknown): void {
  const rawMessages = record(state)?.messages;
  if (!Array.isArray(rawMessages)) return;
  const messages: unknown[] = rawMessages;
  let lastHuman = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (HumanMessage.isInstance(messages[index])) {
      lastHuman = index;
      break;
    }
  }
  const latestAssistant = [...messages.slice(lastHuman + 1)]
    .reverse()
    .find(AIMessage.isInstance);
  if (!latestAssistant) return;
  const returned = new Set(
    messages
      .slice(messages.lastIndexOf(latestAssistant) + 1)
      .filter(ToolMessage.isInstance)
      .map((message) => message.tool_call_id),
  );
  if (
    latestAssistant.tool_calls?.some(
      (call) => call.name === "task" && (!call.id || !returned.has(call.id)),
    )
  )
    unavailable();
}

function mergeScope(previous: Scope | undefined, next: Scope): Scope {
  if (!previous) return next;
  const v2 = isV2(previous);
  if (previous.limit !== next.limit || v2 !== isV2(next)) unavailable();
  if (isV2(previous) && isV2(next)) {
    if (
      previous.normalLimit !== next.normalLimit ||
      previous.closingLimit !== next.closingLimit
    )
      unavailable();
    for (const field of ["availableToolIds", "closingToolIds"] as const) {
      if (
        previous[field] &&
        next[field] &&
        JSON.stringify(previous[field]) !== JSON.stringify(next[field])
      )
        unavailable();
    }
  }
  if (
    previous.summary === "completed" &&
    next.summary === "completed" &&
    previous.summaryText !== next.summaryText
  )
    unavailable();
  const rank = { unused: 0, reserved: 1, completed: 2 };
  const selected =
    previous.steps > next.steps ||
    (previous.steps === next.steps &&
      rank[previous.summary] > rank[next.summary])
      ? previous
      : next;
  if (!isV2(selected)) return selected;
  // The original reserved decision was already consumed. A message rollback
  // cannot replay its old AI response against unrelated earlier messages.
  // Conservatively keep the consumed slot and discard only replay preparation.
  const { decisionPreparation: _preparation, ...safe } = selected;
  if (isV2(previous) && isV2(next))
    return {
      ...safe,
      ...(previous.availableToolIds || next.availableToolIds
        ? {
            availableToolIds:
              previous.availableToolIds ?? next.availableToolIds,
          }
        : {}),
      ...(previous.closingToolIds || next.closingToolIds
        ? { closingToolIds: previous.closingToolIds ?? next.closingToolIds }
        : {}),
    };
  return safe;
}

/** Preserve the ordinary message fork, carrying only trusted execution channels. */
export async function carryAgentStepBudgetIntoRefresh(input: {
  agent: RefreshBudgetAgent;
  destination: AgentRunnableConfig;
  userMessageId: string;
  graphThreadIds: string[];
  checkpointRefs?: AgentCheckpointRef[];
  historyFloors?: AgentCheckpointRef[];
  requireExistingBudget: boolean;
  /** Test seam for deterministic scan-limit negatives; production is fixed. */
  maxCheckpoints?: number;
}): Promise<AgentRunnableConfig> {
  input.destination.signal?.throwIfAborted();
  const origins = [...new Set(input.graphThreadIds)];
  if (
    !origins.length ||
    origins.length > MAX_AGENT_REFRESH_GRAPH_ORIGINS ||
    origins.some((id) => !id.trim())
  )
    unavailable();
  const requiredRefs = new Set(
    (input.checkpointRefs ?? []).map((ref) => {
      if ((ref.checkpointNs ?? "") !== "" || !origins.includes(ref.threadId))
        unavailable();
      return JSON.stringify([ref.threadId, ref.checkpointId]);
    }),
  );
  const floors = new Map(
    (input.historyFloors ?? []).map((ref) => {
      if (
        (ref.checkpointNs ?? "") !== "" ||
        !requiredRefs.has(JSON.stringify([ref.threadId, ref.checkpointId]))
      )
        unavailable();
      return [ref.threadId, ref.checkpointId];
    }),
  );
  const scopes: AgentStepBudgetState["scopes"] = Object.create(null);
  const partials: Record<string, string> = {};
  let seenPolicy = false,
    scanned = 0;
  for (const threadId of origins) {
    let before: AgentRunnableConfig | undefined;
    const visited = new Set<string>();
    let reachedFloor = false;
    let inspectedLatestTarget = false;
    for (;;) {
      input.destination.signal?.throwIfAborted();
      let count = 0,
        last: AgentRunnableConfig | undefined;
      for await (const stateValue of input.agent.getStateHistory(
        {
          ...(input.destination.signal
            ? { signal: input.destination.signal }
            : {}),
          configurable: { thread_id: threadId, checkpoint_ns: "" },
        } as AgentRunnableConfig,
        { limit: PAGE_SIZE, ...(before ? { before } : {}) },
      )) {
        input.destination.signal?.throwIfAborted();
        if (
          ++scanned >
          (input.maxCheckpoints ?? MAX_AGENT_REFRESH_HISTORY_CHECKPOINTS)
        )
          unavailable();
        count++;
        const state = record(stateValue);
        const stateConfig = record(state?.config);
        const configurable = record(stateConfig?.configurable);
        if (
          !state ||
          configurable?.thread_id !== threadId ||
          (configurable.checkpoint_ns ?? "") !== "" ||
          typeof configurable.checkpoint_id !== "string" ||
          visited.has(configurable.checkpoint_id)
        )
          unavailable();
        visited.add(configurable.checkpoint_id);
        requiredRefs.delete(
          JSON.stringify([threadId, configurable.checkpoint_id]),
        );
        last = stateConfig as AgentRunnableConfig;
        // This is the trusted checkpoint immediately before this human's first
        // input on the graph. No decision belonging to that human predates it.
        if (configurable.checkpoint_id === floors.get(threadId)) {
          reachedFloor = true;
          break;
        }
        const budget = readAgentStepBudgetForRefresh(
          state.values,
          input.userMessageId,
        );
        if (!budget) continue;
        if (!inspectedLatestTarget) {
          assertNoUnreturnedRootDelegate(state.values);
          inspectedLatestTarget = true;
        }
        seenPolicy = true;
        for (const [scope, entry] of Object.entries(budget.scopes)) {
          if (
            scope !== "main" &&
            (!scope.startsWith("graph:") || scope.length <= 6)
          )
            unavailable();
          scopes[scope] = mergeScope(scopes[scope], entry);
        }
        let saved: Record<string, string>;
        try {
          saved = readAgentPartialTasksForRefresh(
            state.values,
            input.userMessageId,
          );
        } catch (error) {
          unavailable(error);
        }
        for (const [key, value] of Object.entries(saved)) {
          if (partials[key] !== undefined && partials[key] !== value)
            unavailable();
          partials[key] = value;
        }
      }
      if (reachedFloor || count < PAGE_SIZE) break;
      if (!last) unavailable();
      before = last;
    }
  }
  if (requiredRefs.size) unavailable();
  if (!seenPolicy) {
    if (input.requireExistingBudget) unavailable();
    // Explicit legacy adoption: no private policy anywhere in the authorized
    // root histories, no server origin breadcrumb, and no public policy evidence.
    return input.destination;
  }
  if (!scopes.main && Object.keys(scopes).length) unavailable();
  // Normalize even a single candidate (mergeScope strips preparation on merge).
  for (const [scope, entry] of Object.entries(scopes)) {
    if (isV2(entry)) {
      const { decisionPreparation: _preparation, ...safe } = entry;
      scopes[scope] = safe;
    }
  }
  input.destination.signal?.throwIfAborted();
  const next = await input.agent.updateState(input.destination, {
    sourceweftRunStepBudget: { userMessageId: input.userMessageId, scopes },
    ...(Object.keys(partials).length
      ? { sourceweftPartialTaskResults: partials }
      : {}),
  });
  input.destination.signal?.throwIfAborted();
  if (!record(record(next)?.configurable)?.checkpoint_id) unavailable();
  // Native updateState returns checkpoint coordinates, not the full runnable
  // configuration. Preserve cancellation and host identity for skill-less runs.
  return {
    ...input.destination,
    ...(next as AgentRunnableConfig),
    ...(input.destination.signal ? { signal: input.destination.signal } : {}),
    configurable: {
      ...input.destination.configurable,
      ...record(record(next)?.configurable),
    },
  } as AgentRunnableConfig;
}
