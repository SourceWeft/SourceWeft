import {
  buildAgentConfig,
} from "..";
import type { createThreadAgent } from "..";
import { ContentError } from "../../../content/errors";
import type {
  AgentCheckpointRef,
  PreparedThreadTurn,
} from "../..";
import { toObjectRecord } from "./content";

export type AgentRunnableConfig =
  Awaited<ReturnType<typeof createThreadAgent>> extends {
    stream: (input: unknown, config?: infer Config) => unknown;
  }
    ? NonNullable<Config>
    : Record<string, unknown>;

function checkpointRefToConfig(checkpoint: AgentCheckpointRef) {
  return {
    configurable: {
      thread_id: checkpoint.threadId,
      checkpoint_id: checkpoint.checkpointId,
      checkpoint_ns: checkpoint.checkpointNs ?? "",
    },
  };
}

function checkpointRefToResumeConfig(checkpoint: AgentCheckpointRef) {
  return buildAgentConfig(checkpoint.threadId, {
    checkpoint_map: {
      [checkpoint.checkpointNs ?? ""]: checkpoint.checkpointId,
    },
    checkpoint_ns: checkpoint.checkpointNs ?? "",
  });
}

export function resolveAgentBaseConfig(input: {
  agentBaseCheckpoint: AgentCheckpointRef | null;
  agentMode: PreparedThreadTurn["agentMode"];
  agentRunThreadId: string;
}) {
  if (input.agentMode === "replay") {
    if (!input.agentBaseCheckpoint) {
      throw new ContentError(
        400,
        "AGENT_HITL_CHECKPOINT_REQUIRED",
        "DeepAgents HITL replay requires a checkpoint from the interrupted thread.",
      );
    }
    return checkpointRefToResumeConfig(input.agentBaseCheckpoint);
  }

  return input.agentBaseCheckpoint
    ? checkpointRefToConfig(input.agentBaseCheckpoint)
    : buildAgentConfig(input.agentRunThreadId);
}

export function checkpointRefFromConfig(value: unknown): AgentCheckpointRef | null {
  const config = toObjectRecord(value);
  const configurable = toObjectRecord(config?.configurable);
  if (!configurable) {
    return null;
  }

  const threadId =
    typeof configurable.thread_id === "string" ? configurable.thread_id : null;
  const checkpointId =
    typeof configurable.checkpoint_id === "string"
      ? configurable.checkpoint_id
      : null;
  if (!threadId || !checkpointId) {
    return null;
  }

  const checkpointNs =
    typeof configurable.checkpoint_ns === "string"
      ? configurable.checkpoint_ns
      : undefined;

  return checkpointNs === undefined
    ? { threadId, checkpointId }
    : { threadId, checkpointId, checkpointNs };
}

export function checkpointHasPendingTasks(value: unknown) {
  const record = toObjectRecord(value);
  return Array.isArray(record?.next) && record.next.length > 0;
}

export async function resolvePendingInterruptCheckpoint(input: {
  agent: Awaited<ReturnType<typeof createThreadAgent>>;
  config: AgentRunnableConfig;
}) {
  const state = await getAgentStateOrNull(input.agent, input.config);
  const checkpoint = checkpointRefFromConfig(
    (state as { config?: unknown } | null)?.config,
  );
  return {
    checkpoint,
    pending: checkpointHasPendingTasks(state),
    state,
  };
}

export function resolveHitlInterruptCheckpoint(input: {
  pendingCheckpoint: {
    checkpoint: AgentCheckpointRef | null;
    pending: boolean;
    state?: unknown;
  };
  observedCheckpoint: AgentCheckpointRef | null;
}) {
  if (input.pendingCheckpoint.pending && input.pendingCheckpoint.checkpoint) {
    return input.pendingCheckpoint.checkpoint;
  }

  return input.observedCheckpoint;
}

export async function getAgentStateOrNull(
  agent: Awaited<ReturnType<typeof createThreadAgent>>,
  config: AgentRunnableConfig,
) {
  try {
    return await agent.getState(config);
  } catch {
    return null;
  }
}
