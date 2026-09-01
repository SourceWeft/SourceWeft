import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatThreadRuns, db } from "@sourceweft/db";
import {
  AGENT_TOOL_HOST_LIMITS,
  type AgentToolOperationCacheServices,
  type AgentToolOperationClaimManyResult,
  type AgentToolReceiptServices,
} from "@sourceweft/contracts/agent-tools";
import type { ChatRunSnapshot } from "./types";
import {
  protectedClaimTokenDigest,
  protectedOperationId,
  protectedValueDigest,
  readProtectedAgentToolState,
  type ProtectedAgentToolScope,
  type ProtectedAgentToolState,
  type ProtectedSemanticOperation,
  writeProtectedAgentToolState,
} from "./protected-agent-tool-state";

type ProtectedStateTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

type ProtectedStateMutation<T> = {
  result: T;
  state?: ProtectedAgentToolState;
};

function assertBoundedIdentifier(value: string, label: string, max = 512) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(
      `PROTECTED_AGENT_TOOL_INPUT_INVALID: ${label} must be 1-${max} characters`,
    );
  }
  return normalized;
}

function safeReason(value: string) {
  return assertBoundedIdentifier(value, "reason", 160).replace(
    /[^a-zA-Z0-9_.:-]/gu,
    "_",
  );
}

function assertOperationShape(
  operation: ProtectedSemanticOperation,
  input: { semanticKey: string; toolName: string },
) {
  if (
    operation.semanticKey !== input.semanticKey ||
    operation.toolName !== input.toolName ||
    (operation.status !== "in_progress" &&
      operation.status !== "completed" &&
      operation.status !== "unknown")
  ) {
    throw new Error(
      "PROTECTED_AGENT_TOOL_STATE_INVALID: semantic operation identity mismatch",
    );
  }
}

async function mutateProtectedState<T>(input: {
  scope: ProtectedAgentToolScope;
  requireActive: boolean;
  mutate: (
    state: ProtectedAgentToolState,
    now: string,
  ) => ProtectedStateMutation<T>;
}): Promise<T> {
  return db.transaction(async (tx) =>
    mutateProtectedStateInTransaction(tx, input),
  );
}

async function mutateProtectedStateInTransaction<T>(
  tx: ProtectedStateTransaction,
  input: {
    scope: ProtectedAgentToolScope;
    requireActive: boolean;
    mutate: (
      state: ProtectedAgentToolState,
      now: string,
    ) => ProtectedStateMutation<T>;
  },
) {
  const [run] = await tx
    .select({
      id: chatThreadRuns.id,
      status: chatThreadRuns.status,
      snapshotJson: chatThreadRuns.snapshotJson,
    })
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.id, input.scope.runId),
        eq(chatThreadRuns.teamId, input.scope.teamId),
        eq(chatThreadRuns.workspaceId, input.scope.workspaceId),
      ),
    )
    .for("update")
    .limit(1);
  if (!run) {
    throw new Error("PROTECTED_AGENT_TOOL_RUN_NOT_FOUND");
  }
  if (input.requireActive && run.status !== "running") {
    throw new Error(
      `PROTECTED_AGENT_TOOL_RUN_NOT_ACTIVE: run status is ${run.status}`,
    );
  }
  const snapshot = (run.snapshotJson ?? {}) as ChatRunSnapshot;
  const state = readProtectedAgentToolState({ snapshot, scope: input.scope });
  const mutation = input.mutate(state, new Date().toISOString());
  if (mutation.state) {
    const nextSnapshot = writeProtectedAgentToolState({
      snapshot,
      state: mutation.state,
    });
    const [updated] = await tx
      .update(chatThreadRuns)
      .set({
        snapshotJson: nextSnapshot as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatThreadRuns.id, run.id),
          eq(chatThreadRuns.status, run.status),
        ),
      )
      .returning({ id: chatThreadRuns.id });
    if (!updated) {
      throw new Error("PROTECTED_AGENT_TOOL_RUN_FENCE_LOST");
    }
  }
  return mutation.result;
}

export function createProtectedRunReceiptServices(input: {
  scope: ProtectedAgentToolScope;
  assertRootToolCall: (input: {
    toolName?: string;
    toolCallId?: string;
  }) => void;
}): AgentToolReceiptServices {
  return {
    issueCurrentRunReceipt: async (receiptInput) => {
      input.assertRootToolCall({
        toolName: receiptInput.producerToolName,
        toolCallId: receiptInput.producerToolCallId,
      });
      const producerToolName = assertBoundedIdentifier(
        receiptInput.producerToolName,
        "producerToolName",
        160,
      );
      const producerToolCallId = assertBoundedIdentifier(
        receiptInput.producerToolCallId,
        "producerToolCallId",
        256,
      );
      const schemaVersion = assertBoundedIdentifier(
        receiptInput.schemaVersion,
        "schemaVersion",
        160,
      );
      const payload = structuredClone(receiptInput.payload) as Record<
        string,
        unknown
      >;
      const payloadDigest = protectedValueDigest(payload);
      const receiptId = `receipt_${protectedValueDigest({
        runId: input.scope.runId,
        producerToolName,
        producerToolCallId,
        schemaVersion,
        payloadDigest,
      }).slice(0, 40)}`;
      return mutateProtectedState({
        scope: input.scope,
        requireActive: true,
        mutate: (state, issuedAt) => {
          const existing = state.trustedReceipts[receiptId];
          if (existing) {
            if (
              existing.producerToolName !== producerToolName ||
              existing.producerToolCallId !== producerToolCallId ||
              existing.schemaVersion !== schemaVersion ||
              existing.payloadDigest !== payloadDigest
            ) {
              throw new Error("PROTECTED_AGENT_TOOL_RECEIPT_CONFLICT");
            }
            return { result: { receiptId } };
          }
          const nextState: ProtectedAgentToolState = {
            ...state,
            trustedReceipts: {
              ...state.trustedReceipts,
              [receiptId]: {
                receiptId,
                producerToolName,
                producerToolCallId,
                schemaVersion,
                executionScope: "root_only",
                payload,
                payloadDigest,
                issuedAt,
              },
            },
          };
          return { result: { receiptId }, state: nextState };
        },
      });
    },
    resolveCurrentRunReceipt: async (receiptInput) => {
      input.assertRootToolCall({});
      if (receiptInput.executionScope !== "root_only") {
        return null;
      }
      return mutateProtectedState({
        scope: input.scope,
        requireActive: true,
        mutate: (state) => {
          const receipt = state.trustedReceipts[receiptInput.receiptId];
          if (
            !receipt ||
            receipt.executionScope !== "root_only" ||
            receipt.producerToolName !== receiptInput.producerToolName ||
            (receiptInput.expectedSchemaVersion !== undefined &&
              receipt.schemaVersion !== receiptInput.expectedSchemaVersion)
          ) {
            return { result: null };
          }
          if (protectedValueDigest(receipt.payload) !== receipt.payloadDigest) {
            throw new Error("PROTECTED_AGENT_TOOL_RECEIPT_DIGEST_MISMATCH");
          }
          return { result: structuredClone(receipt.payload) };
        },
      });
    },
  };
}

export function createProtectedRunOperationCacheServices(input: {
  scope: ProtectedAgentToolScope;
  maxOperations: number;
  assertRootToolCall: (input: {
    toolName?: string;
    toolCallId?: string;
  }) => void;
}): AgentToolOperationCacheServices {
  const maxOperations = Math.min(
    Math.max(1, input.maxOperations),
    AGENT_TOOL_HOST_LIMITS.operationClaimMaxKeys,
  );
  return {
    claimMany: async (claimInput) => {
      input.assertRootToolCall({
        toolName: claimInput.toolName,
        toolCallId: claimInput.toolCallId,
      });
      if (claimInput.executionScope !== "root_only") {
        throw new Error("PROTECTED_AGENT_TOOL_ROOT_SCOPE_REQUIRED");
      }
      if (
        claimInput.semanticKeys.length === 0 ||
        claimInput.semanticKeys.length >
          AGENT_TOOL_HOST_LIMITS.operationClaimMaxKeys
      ) {
        throw new Error("PROTECTED_AGENT_TOOL_CLAIM_BATCH_INVALID");
      }
      const toolName = assertBoundedIdentifier(
        claimInput.toolName,
        "toolName",
        160,
      );
      const ownerToolCallId = assertBoundedIdentifier(
        claimInput.toolCallId,
        "toolCallId",
        256,
      );
      const semanticKeys = Array.from(
        new Set(
          claimInput.semanticKeys.map((key) =>
            assertBoundedIdentifier(key, "semanticKey"),
          ),
        ),
      ).sort();

      return mutateProtectedState({
        scope: input.scope,
        requireActive: true,
        mutate: (
          state,
          claimedAt,
        ): ProtectedStateMutation<AgentToolOperationClaimManyResult> => {
          const existingItems: Extract<
            AgentToolOperationClaimManyResult,
            { kind: "claimed" }
          >["items"][number][] = [];
          const missing: Array<{ semanticKey: string; operationId: string }> =
            [];
          for (const semanticKey of semanticKeys) {
            const operationId = protectedOperationId(toolName, semanticKey);
            const operation = state.semanticOperations[operationId];
            if (!operation) {
              missing.push({ semanticKey, operationId });
              continue;
            }
            assertOperationShape(operation, { semanticKey, toolName });
            if (operation.status === "unknown") {
              return {
                result: {
                  kind: "unknown",
                  code: "SIDE_EFFECT_OUTCOME_UNKNOWN",
                },
              };
            }
            if (operation.status === "in_progress") {
              return {
                result: {
                  kind: "wait",
                  ownerToolCallId: operation.ownerToolCallId,
                },
              };
            }
            if (
              protectedValueDigest(operation.observation) !==
              operation.observationDigest
            ) {
              throw new Error(
                "PROTECTED_AGENT_TOOL_OBSERVATION_DIGEST_MISMATCH",
              );
            }
            existingItems.push({
              semanticKey,
              action: "reuse",
              observationId: operation.observationId,
              observation: structuredClone(operation.observation),
            });
          }
          if (
            Object.keys(state.semanticOperations).length + missing.length >
            maxOperations
          ) {
            throw new Error("PROTECTED_AGENT_TOOL_OPERATION_CAPACITY");
          }
          if (missing.length === 0) {
            return { result: { kind: "claimed", items: existingItems } };
          }
          const semanticOperations = { ...state.semanticOperations };
          const claimedItems = [...existingItems];
          for (const item of missing) {
            const claimToken = randomUUID();
            semanticOperations[item.operationId] = {
              semanticKey: item.semanticKey,
              toolName,
              ownerToolCallId,
              status: "in_progress",
              claimToken,
              claimedAt,
            };
            claimedItems.push({
              semanticKey: item.semanticKey,
              action: "execute",
              claimToken,
            });
          }
          claimedItems.sort((left, right) =>
            left.semanticKey.localeCompare(right.semanticKey),
          );
          return {
            result: { kind: "claimed", items: claimedItems },
            state: { ...state, semanticOperations },
          };
        },
      });
    },
    complete: async (completeInput) => {
      input.assertRootToolCall({
        toolName: completeInput.toolName,
      });
      const toolName = assertBoundedIdentifier(
        completeInput.toolName,
        "toolName",
        160,
      );
      const semanticKey = assertBoundedIdentifier(
        completeInput.semanticKey,
        "semanticKey",
      );
      const claimToken = assertBoundedIdentifier(
        completeInput.claimToken,
        "claimToken",
        256,
      );
      const observation = structuredClone(completeInput.observation) as Record<
        string,
        unknown
      >;
      const observationDigest = protectedValueDigest(observation);
      type CompleteOutcome =
        | { kind: "completed"; observationId: string }
        | { kind: "error"; error: Error };
      const outcome = await mutateProtectedState<CompleteOutcome>({
        scope: input.scope,
        requireActive: true,
        mutate: (state, completedAt) => {
          const id = protectedOperationId(toolName, semanticKey);
          const operation = state.semanticOperations[id];
          if (!operation) {
            throw new Error("PROTECTED_AGENT_TOOL_CLAIM_NOT_FOUND");
          }
          assertOperationShape(operation, { semanticKey, toolName });
          if (operation.status === "completed") {
            if (
              operation.claimTokenDigest !==
                protectedClaimTokenDigest(claimToken) ||
              operation.observationDigest !== observationDigest
            ) {
              throw new Error("PROTECTED_AGENT_TOOL_COMPLETE_CONFLICT");
            }
            return {
              result: {
                kind: "completed",
                observationId: operation.observationId,
              },
            };
          }
          if (
            operation.status !== "in_progress" ||
            operation.claimToken !== claimToken
          ) {
            throw new Error("PROTECTED_AGENT_TOOL_CLAIM_FENCE_LOST");
          }
          const observationId = randomUUID();
          const completed: ProtectedSemanticOperation = {
            semanticKey,
            toolName,
            ownerToolCallId: operation.ownerToolCallId,
            status: "completed",
            claimTokenDigest: protectedClaimTokenDigest(claimToken),
            observationId,
            observation,
            observationDigest,
            completedAt,
          };
          const nextState = {
            ...state,
            semanticOperations: {
              ...state.semanticOperations,
              [id]: completed,
            },
          };
          try {
            writeProtectedAgentToolState({ snapshot: {}, state: nextState });
          } catch (error) {
            const unknown: ProtectedSemanticOperation = {
              semanticKey,
              toolName,
              ownerToolCallId: operation.ownerToolCallId,
              status: "unknown",
              claimTokenDigest: protectedClaimTokenDigest(claimToken),
              reason: "OBSERVATION_CAPACITY_EXCEEDED",
              markedAt: completedAt,
            };
            return {
              result: {
                kind: "error",
                error:
                  error instanceof Error ? error : new Error(String(error)),
              },
              state: {
                ...state,
                semanticOperations: {
                  ...state.semanticOperations,
                  [id]: unknown,
                },
              },
            };
          }
          return {
            result: { kind: "completed", observationId },
            state: nextState,
          };
        },
      });
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      return { observationId: outcome.observationId };
    },
    markUnknown: async (unknownInput) => {
      input.assertRootToolCall({
        toolName: unknownInput.toolName,
      });
      const toolName = assertBoundedIdentifier(
        unknownInput.toolName,
        "toolName",
        160,
      );
      const semanticKey = assertBoundedIdentifier(
        unknownInput.semanticKey,
        "semanticKey",
      );
      const claimToken = assertBoundedIdentifier(
        unknownInput.claimToken,
        "claimToken",
        256,
      );
      const reason = safeReason(unknownInput.reason);
      await mutateProtectedState({
        scope: input.scope,
        requireActive: true,
        mutate: (state, markedAt) => {
          const id = protectedOperationId(toolName, semanticKey);
          const operation = state.semanticOperations[id];
          if (!operation) {
            throw new Error("PROTECTED_AGENT_TOOL_CLAIM_NOT_FOUND");
          }
          assertOperationShape(operation, { semanticKey, toolName });
          const tokenDigest = protectedClaimTokenDigest(claimToken);
          if (operation.status === "unknown") {
            if (operation.claimTokenDigest !== tokenDigest) {
              throw new Error("PROTECTED_AGENT_TOOL_CLAIM_FENCE_LOST");
            }
            return { result: undefined };
          }
          if (
            operation.status !== "in_progress" ||
            operation.claimToken !== claimToken
          ) {
            throw new Error("PROTECTED_AGENT_TOOL_CLAIM_FENCE_LOST");
          }
          return {
            result: undefined,
            state: {
              ...state,
              semanticOperations: {
                ...state.semanticOperations,
                [id]: {
                  semanticKey,
                  toolName,
                  ownerToolCallId: operation.ownerToolCallId,
                  status: "unknown",
                  claimTokenDigest: tokenDigest,
                  reason,
                  markedAt,
                },
              },
            },
          };
        },
      });
    },
  };
}
