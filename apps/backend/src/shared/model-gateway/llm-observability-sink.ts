import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
  ObserveSink,
  ObserveSpan,
  UsageInfo,
} from "@sourceweft/model-gateway";
import { db } from "../database";
import { llmGenerations, modelGatewayEvents } from "../db/schema";
import {
  endGeneration,
  recordGenerationError,
  startGeneration,
} from "../llm-observability";
import { redactRecord } from "../llm-observability/redaction";
import { logger } from "../logger";
import { workspaceService } from "../../modules/workspace";

// Adapter from model-gateway observation events to backend llm-observability persistence.
const RESERVED_EVENT_ATTRIBUTE_KEYS = new Set([
  "teamId",
  "team_id",
  "workspaceId",
  "workspace_id",
  "userId",
  "user_id",
  "threadId",
  "thread_id",
  "messageId",
  "message_id",
  "feature",
  "operation",
  "environment",
  "env",
  "executionMode",
  "keySource",
  "provider",
  "modelAlias",
  "byokModelId",
  "credentialId",
  "providerModel",
  "routeStrategy",
  "latencyMs",
]);

export type GatewayEventInput = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  teamId: string;
  workspaceId: string;
  userId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  feature?: string | null;
  operation: string;
  executionMode?: string | null;
  keySource?: string | null;
  provider?: string | null;
  providerModel?: string | null;
  modelAlias?: string | null;
  routeStrategy?: string | null;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  usage?: UsageInfo;
  providerCostUsd?: number | null;
  attributes?: Record<string, unknown>;
};

function toNumeric(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toFixed(6);
}

function buildEventAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !RESERVED_EVENT_ATTRIBUTE_KEYS.has(key),
    ),
  );
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readAttributeString(
  attributes: Record<string, unknown>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = readString(attributes[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractGenerationContext(
  generation:
    | ObserveGenerationStart
    | ObserveGenerationEnd
    | ObserveGenerationError,
) {
  const attributes = generation.attributes ?? {};
  return {
    teamId: readAttributeString(attributes, "teamId", "team_id"),
    workspaceId: readAttributeString(attributes, "workspaceId", "workspace_id"),
    userId: readAttributeString(attributes, "userId", "user_id"),
    threadId: readAttributeString(attributes, "threadId", "thread_id"),
    messageId: readAttributeString(attributes, "messageId", "message_id"),
    feature: readAttributeString(attributes, "feature"),
  };
}

function hasGenerationScope(
  context: ReturnType<typeof extractGenerationContext>,
): context is ReturnType<typeof extractGenerationContext> & {
  teamId: string;
  workspaceId: string;
} {
  return Boolean(context.teamId && context.workspaceId);
}

async function validateObservationScope(scope: {
  teamId: string;
  workspaceId: string;
}) {
  const workspace = await workspaceService.findWorkspaceInOrganization({
    workspaceId: scope.workspaceId,
    organizationId: scope.teamId,
  });
  return workspace ? scope : null;
}

async function resolveGenerationScope(
  generation: ObserveGenerationEnd | ObserveGenerationError,
) {
  const context = extractGenerationContext(generation);
  if (hasGenerationScope(context)) {
    const scope = await validateObservationScope(context);
    return scope
      ? {
          teamId: scope.teamId,
          workspaceId: scope.workspaceId,
          userId: context.userId,
          threadId: context.threadId,
          messageId: context.messageId,
          feature: context.feature,
        }
      : null;
  }
  if (generation.traceId) {
    const [startedGeneration] = await db
      .select({
        teamId: llmGenerations.teamId,
        workspaceId: llmGenerations.workspaceId,
        userId: llmGenerations.userId,
        threadId: llmGenerations.threadId,
        messageId: llmGenerations.messageId,
        metadataJson: llmGenerations.metadataJson,
      })
      .from(llmGenerations)
      .where(
        and(
          eq(llmGenerations.traceId, generation.traceId),
          eq(llmGenerations.spanId, generation.spanId),
        ),
      )
      .limit(1);
    if (startedGeneration) {
      const metadata =
        startedGeneration.metadataJson &&
        typeof startedGeneration.metadataJson === "object"
          ? startedGeneration.metadataJson
          : {};
      return {
        teamId: startedGeneration.teamId,
        workspaceId: startedGeneration.workspaceId,
        userId: startedGeneration.userId,
        threadId: startedGeneration.threadId,
        messageId: startedGeneration.messageId,
        feature: readAttributeString(metadata, "feature"),
      };
    }
  }
  logger.warn("LLM generation observation missing scope", {
    traceId: generation.traceId,
    spanId: generation.spanId,
  });
  return null;
}

export async function createModelGatewayEvent(input: GatewayEventInput) {
  await db.insert(modelGatewayEvents).values({
    id: randomUUID(),
    traceId: input.traceId ?? null,
    spanId: input.spanId ?? null,
    parentSpanId: input.parentSpanId ?? null,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    feature: input.feature ?? null,
    operation: input.operation,
    executionMode: input.executionMode ?? null,
    keySource: input.keySource ?? null,
    provider: input.provider ?? null,
    providerModel: input.providerModel ?? null,
    modelAlias: input.modelAlias ?? null,
    routeStrategy: input.routeStrategy ?? null,
    success: input.success,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    latencyMs: input.latencyMs ?? null,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    totalTokens: input.usage?.totalTokens ?? null,
    providerCostUsd: toNumeric(input.providerCostUsd),
    attributesJson: redactRecord(input.attributes) ?? {},
    createdAt: new Date(),
  });
}

export function createLlmObservabilitySink(): ObserveSink {
  return {
    async onGenerationStart(generation: ObserveGenerationStart) {
      const context = extractGenerationContext(generation);
      if (!generation.traceId || !context.teamId || !context.workspaceId) {
        return;
      }
      const scope = await validateObservationScope({
        teamId: context.teamId,
        workspaceId: context.workspaceId,
      });
      if (!scope) {
        logger.warn("LLM generation observation has invalid scope", {
          traceId: generation.traceId,
          spanId: generation.spanId,
          teamId: context.teamId,
          workspaceId: context.workspaceId,
        });
        return;
      }

      await startGeneration({
        traceId: generation.traceId,
        spanId: generation.spanId,
        parentSpanId: generation.parentSpanId,
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        userId: context.userId,
        threadId: context.threadId,
        messageId: context.messageId,
        feature: context.feature,
        operation: generation.operation,
        modelAlias: generation.modelAlias,
        provider: generation.provider,
        providerModel: generation.providerModel,
        executionMode: generation.executionMode,
        routeStrategy: generation.routeDecision?.strategy,
        routeDecision: generation.routeDecision,
        modelParameters: generation.modelParameters,
        input: generation.input,
        rawCaptureMode: generation.rawCaptureMode,
        metadata: {
          ...(generation.name ? { observationName: generation.name } : {}),
          ...buildEventAttributes(generation.attributes ?? {}),
        },
        startedAt: new Date(generation.startedAt),
      });
    },
    async onGenerationEnd(generation: ObserveGenerationEnd) {
      const scope = await resolveGenerationScope(generation);
      if (!generation.traceId || !scope) {
        return;
      }
      await endGeneration({
        traceId: generation.traceId,
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        spanId: generation.spanId,
        output: generation.output,
        outputText: generation.outputText,
        finishReason: generation.finishReason,
        reasoningText: generation.reasoningText,
        providerFields: generation.providerFields,
        usage: generation.usage,
        providerResponse: generation.providerResponse,
        providerStatusCode: generation.providerStatusCode,
        providerRequestId: generation.providerRequestId,
        rawCaptureError: generation.rawCaptureError,
        latencyMs: generation.latencyMs,
        metadata: buildEventAttributes(generation.attributes ?? {}),
        endedAt: new Date(generation.endedAt),
      });
    },
    async onGenerationError(generation: ObserveGenerationError) {
      const scope = await resolveGenerationScope(generation);
      if (!generation.traceId || !scope) {
        return;
      }
      await recordGenerationError({
        traceId: generation.traceId,
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        spanId: generation.spanId,
        errorCode: generation.errorCode,
        errorMessage: generation.errorMessage,
        providerResponse: readRecord(generation.providerResponse),
        providerStatusCode: generation.providerStatusCode,
        providerRequestId: generation.providerRequestId,
        rawCaptureError: generation.rawCaptureError,
        latencyMs: generation.latencyMs,
        metadata: buildEventAttributes(generation.attributes ?? {}),
        endedAt: new Date(generation.endedAt),
      });
    },
    async onSpan(span: ObserveSpan) {
      const attributes = span.attributes ?? {};
      const teamId =
        readAttributeString(attributes, "teamId", "team_id") ?? undefined;
      const workspaceId =
        readAttributeString(attributes, "workspaceId", "workspace_id") ??
        undefined;

      if (!teamId || !workspaceId) {
        return;
      }
      const scope = await validateObservationScope({ teamId, workspaceId });
      if (!scope) {
        logger.warn("LLM span observation has invalid scope", {
          traceId: span.traceId,
          spanId: span.spanId,
          teamId,
          workspaceId,
        });
        return;
      }

      await createModelGatewayEvent({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        userId: readAttributeString(attributes, "userId", "user_id"),
        threadId: readAttributeString(attributes, "threadId", "thread_id"),
        messageId: readAttributeString(attributes, "messageId", "message_id"),
        feature: readAttributeString(attributes, "feature"),
        operation:
          typeof attributes.operation === "string"
            ? attributes.operation
            : span.name,
        executionMode:
          typeof attributes.executionMode === "string"
            ? attributes.executionMode
            : null,
        keySource:
          typeof attributes.keySource === "string"
            ? attributes.keySource
            : null,
        provider:
          typeof attributes.provider === "string" ? attributes.provider : null,
        modelAlias:
          typeof attributes.modelAlias === "string"
            ? attributes.modelAlias
            : null,
        providerModel:
          typeof attributes.providerModel === "string"
            ? attributes.providerModel
            : null,
        routeStrategy:
          typeof attributes.routeStrategy === "string"
            ? attributes.routeStrategy
            : null,
        success: span.status === "ok",
        errorCode: span.errorCode,
        errorMessage: span.errorMessage,
        latencyMs:
          typeof attributes.latencyMs === "number"
            ? attributes.latencyMs
            : null,
        attributes: buildEventAttributes(attributes),
      });
    },
  };
}
