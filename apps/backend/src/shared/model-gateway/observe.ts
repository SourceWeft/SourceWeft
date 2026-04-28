import { randomUUID } from "node:crypto";
import type { ObserveSink, ObserveSpan, UsageInfo } from "@sourceweft/model-gateway";
import { db } from "../database";
import { modelGatewayEvents } from "../db/schema";

const RESERVED_EVENT_ATTRIBUTE_KEYS = new Set([
  "teamId",
  "workspaceId",
  "userId",
  "threadId",
  "messageId",
  "feature",
  "operation",
  "executionMode",
  "keySource",
  "provider",
  "providerModel",
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
    Object.entries(attributes).filter(([key]) => !RESERVED_EVENT_ATTRIBUTE_KEYS.has(key)),
  );
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
    attributesJson: input.attributes ?? {},
    createdAt: new Date(),
  });
}

export function createDatabaseObserveSink(): ObserveSink {
  return {
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
        providerModel:
          typeof attributes.providerModel === "string"
            ? attributes.providerModel
            : null,
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
