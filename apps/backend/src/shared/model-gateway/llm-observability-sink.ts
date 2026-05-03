import { randomUUID } from "node:crypto";
import type {
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
  ObserveSink,
  ObserveSpan,
  UsageInfo,
} from "@sourceweft/model-gateway";
import { db } from "../database";
import { modelGatewayEvents } from "../db/schema";
import {
  endGeneration,
  recordGenerationError,
  startGeneration,
} from "../llm-observability";

// Adapter from model-gateway observation events to backend llm-observability persistence.
const RESERVED_EVENT_ATTRIBUTE_KEYS = new Set([
  "teamId",
  "workspaceId",
  "userId",
  "threadId",
  "messageId",
  "feature",
  "operation",
  "environment",
  "env",
  "executionMode",
  "keySource",
  "provider",
  "modelAlias",
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
    Object.entries(attributes).filter(([key]) => !RESERVED_EVENT_ATTRIBUTE_KEYS.has(key)),
  );
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractGenerationContext(
  generation: ObserveGenerationStart | ObserveGenerationEnd | ObserveGenerationError,
) {
  const attributes = generation.attributes ?? {};
  return {
    teamId: readString(attributes.teamId),
    workspaceId: readString(attributes.workspaceId),
    userId: readString(attributes.userId),
    threadId: readString(attributes.threadId),
    messageId: readString(attributes.messageId),
    feature: readString(attributes.feature),
  };
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
    providerModel: null,
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
    attributesJson: input.attributes ?? {},
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

      await startGeneration({
        traceId: generation.traceId,
        spanId: generation.spanId,
        parentSpanId: generation.parentSpanId,
        teamId: context.teamId,
        workspaceId: context.workspaceId,
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
      if (!generation.traceId) {
        return;
      }
      await endGeneration({
        traceId: generation.traceId,
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
      if (!generation.traceId) {
        return;
      }
      await recordGenerationError({
        traceId: generation.traceId,
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
        typeof attributes.teamId === "string" ? attributes.teamId : undefined;
      const workspaceId =
        typeof attributes.workspaceId === "string"
          ? attributes.workspaceId
          : undefined;

      if (!teamId || !workspaceId) {
        return;
      }

      await createModelGatewayEvent({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        teamId,
        workspaceId,
        userId: typeof attributes.userId === "string" ? attributes.userId : null,
        threadId:
          typeof attributes.threadId === "string" ? attributes.threadId : null,
        messageId:
          typeof attributes.messageId === "string" ? attributes.messageId : null,
        feature: typeof attributes.feature === "string" ? attributes.feature : null,
        operation:
          typeof attributes.operation === "string"
            ? attributes.operation
            : span.name,
        executionMode:
          typeof attributes.executionMode === "string"
            ? attributes.executionMode
            : null,
        keySource:
          typeof attributes.keySource === "string" ? attributes.keySource : null,
        provider:
          typeof attributes.provider === "string" ? attributes.provider : null,
        modelAlias:
          typeof attributes.modelAlias === "string" ? attributes.modelAlias : null,
        routeStrategy:
          typeof attributes.routeStrategy === "string"
            ? attributes.routeStrategy
            : null,
        success: span.status === "ok",
        errorCode: span.errorCode,
        errorMessage: span.errorMessage,
        latencyMs:
          typeof attributes.latencyMs === "number" ? attributes.latencyMs : null,
        attributes: buildEventAttributes(attributes),
      });
    },
  };
}
