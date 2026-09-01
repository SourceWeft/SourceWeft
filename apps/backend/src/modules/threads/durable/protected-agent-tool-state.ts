import { createHash } from "node:crypto";
import { AGENT_TOOL_HOST_LIMITS } from "@sourceweft/contracts/agent-tools";
import type { ChatRunSnapshot } from "./types";

export const PROTECTED_AGENT_TOOL_STATE_VERSION = 1 as const;

export type ProtectedAgentToolScope = {
  teamId: string;
  workspaceId: string;
  runId: string;
};

export type ProtectedAgentToolReceipt = {
  receiptId: string;
  producerToolName: string;
  producerToolCallId: string;
  schemaVersion: string;
  executionScope: "root_only";
  payload: Record<string, unknown>;
  payloadDigest: string;
  issuedAt: string;
};

type ProtectedOperationBase = {
  semanticKey: string;
  toolName: string;
  ownerToolCallId: string;
};

export type ProtectedSemanticOperation =
  | (ProtectedOperationBase & {
      status: "in_progress";
      claimToken: string;
      claimedAt: string;
    })
  | (ProtectedOperationBase & {
      status: "completed";
      claimTokenDigest: string;
      observationId: string;
      observation: Record<string, unknown>;
      observationDigest: string;
      completedAt: string;
    })
  | (ProtectedOperationBase & {
      status: "unknown";
      claimTokenDigest: string;
      reason: string;
      markedAt: string;
    });

export type ProtectedAgentToolState = {
  version: typeof PROTECTED_AGENT_TOOL_STATE_VERSION;
  scope: ProtectedAgentToolScope;
  trustedReceipts: Record<string, ProtectedAgentToolReceipt>;
  semanticOperations: Record<string, ProtectedSemanticOperation>;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error(
      "PROTECTED_AGENT_TOOL_JSON_INVALID: binary data belongs in the WIP blob store",
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("PROTECTED_AGENT_TOOL_JSON_INVALID: non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  const record = objectRecord(value);
  if (!record) {
    throw new Error("PROTECTED_AGENT_TOOL_JSON_INVALID: unsupported value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "PROTECTED_AGENT_TOOL_JSON_INVALID: only plain JSON objects are allowed",
    );
  }
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalJsonValue(record[key])]),
  );
}

export function canonicalProtectedJson(value: unknown) {
  return JSON.stringify(canonicalJsonValue(value));
}

export function protectedValueDigest(value: unknown) {
  return createHash("sha256")
    .update(canonicalProtectedJson(value))
    .digest("hex");
}

export function protectedOperationId(toolName: string, semanticKey: string) {
  return createHash("sha256")
    .update(`${toolName}\0${semanticKey}`)
    .digest("hex");
}

export function protectedClaimTokenDigest(claimToken: string) {
  return createHash("sha256").update(claimToken).digest("hex");
}

export function assertProtectedAgentToolStateSize(
  state: ProtectedAgentToolState,
) {
  const size = Buffer.byteLength(canonicalProtectedJson(state), "utf8");
  if (size > AGENT_TOOL_HOST_LIMITS.protectedJsonMaxBytes) {
    throw new Error(
      `PROTECTED_AGENT_TOOL_STATE_CAPACITY: ${size} bytes exceeds ${AGENT_TOOL_HOST_LIMITS.protectedJsonMaxBytes}`,
    );
  }
}

function isScope(value: unknown, expected: ProtectedAgentToolScope) {
  const scope = objectRecord(value);
  return (
    scope?.teamId === expected.teamId &&
    scope.workspaceId === expected.workspaceId &&
    scope.runId === expected.runId
  );
}

export function readProtectedAgentToolState(input: {
  snapshot: ChatRunSnapshot;
  scope: ProtectedAgentToolScope;
}): ProtectedAgentToolState {
  const raw = input.snapshot.protectedAgentTools;
  if (raw === undefined) {
    return {
      version: PROTECTED_AGENT_TOOL_STATE_VERSION,
      scope: input.scope,
      trustedReceipts: {},
      semanticOperations: {},
    };
  }
  const state = objectRecord(raw);
  if (
    state?.version !== PROTECTED_AGENT_TOOL_STATE_VERSION ||
    !isScope(state.scope, input.scope) ||
    !objectRecord(state.trustedReceipts) ||
    !objectRecord(state.semanticOperations)
  ) {
    throw new Error(
      "PROTECTED_AGENT_TOOL_STATE_INVALID: malformed, unscoped, or unsupported protected state",
    );
  }
  return structuredClone(state) as ProtectedAgentToolState;
}

export function writeProtectedAgentToolState(input: {
  snapshot: ChatRunSnapshot;
  state: ProtectedAgentToolState;
}): ChatRunSnapshot {
  assertProtectedAgentToolStateSize(input.state);
  return {
    ...input.snapshot,
    protectedAgentTools: input.state as unknown as Record<string, unknown>,
  };
}

export function fenceProtectedOperationsForTerminal(input: {
  snapshot: ChatRunSnapshot;
  scope: ProtectedAgentToolScope;
  reason: string;
  markedAt: string;
}) {
  if (input.snapshot.protectedAgentTools === undefined) {
    return input.snapshot;
  }
  const state = readProtectedAgentToolState({
    snapshot: input.snapshot,
    scope: input.scope,
  });
  let changed = false;
  const semanticOperations = Object.fromEntries(
    Object.entries(state.semanticOperations).map(([id, operation]) => {
      if (operation.status !== "in_progress") {
        return [id, operation];
      }
      changed = true;
      return [
        id,
        {
          semanticKey: operation.semanticKey,
          toolName: operation.toolName,
          ownerToolCallId: operation.ownerToolCallId,
          status: "unknown",
          claimTokenDigest: protectedClaimTokenDigest(operation.claimToken),
          reason: input.reason.slice(0, 160),
          markedAt: input.markedAt,
        } satisfies ProtectedSemanticOperation,
      ];
    }),
  );
  if (!changed) {
    return input.snapshot;
  }
  return writeProtectedAgentToolState({
    snapshot: input.snapshot,
    state: { ...state, semanticOperations },
  });
}
