import { and, eq } from "drizzle-orm";
import type {
  ObserveGenerationEnd,
  ObserveGenerationError,
  ObserveGenerationStart,
  ObserveSink,
  ObserveSpan,
} from "@sourceweft/model-gateway";
import { db, llmGenerations } from "@sourceweft/db";
import {
  endGeneration,
  recordGenerationError,
  startGeneration,
} from ".";
import { logger } from "../../shared/logger";
import { workspaceService } from "../workspace";

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

/**
 * Resolves what a generation cost the platform. Injected rather than imported
 * so this module stays free of billing/pricing concerns, and so tests can drive
 * the sink without a price book.
 */
export type GenerationCostResolver = (input: {
  gatewayConfigId: string;
  modelKind: string;
  profileAlias: string;
  usage?: ObserveGenerationEnd["usage"];
  executionMode?: string | null;
}) => Promise<number | null>;

async function resolveGenerationCost(
  resolveCost: GenerationCostResolver | undefined,
  generation: ObserveGenerationEnd,
): Promise<number | null> {
  if (!resolveCost) {
    return null;
  }

  const attributes = generation.attributes ?? {};
  const gatewayConfigId = readAttributeString(attributes, "gatewayConfigId");
  const profileAlias = readAttributeString(attributes, "profileAlias");
  const modelKind = readAttributeString(attributes, "modelKind");

  // Cost needs the host's billing identity, which only reaches the gateway when
  // the caller went through the billed wrapper. Anything else stays uncosted
  // rather than being attributed to the wrong price book entry.
  if (!gatewayConfigId || !profileAlias || !modelKind) {
    return null;
  }

  try {
    return await resolveCost({
      gatewayConfigId,
      modelKind,
      profileAlias,
      usage: generation.usage,
      executionMode: readAttributeString(attributes, "executionMode"),
    });
  } catch (error) {
    // Cost is observability, never a reason to lose the generation record.
    logger.warn("Failed to resolve generation cost", {
      traceId: generation.traceId,
      spanId: generation.spanId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function createLlmObservabilitySink(options?: {
  resolveCost?: GenerationCostResolver;
}): ObserveSink {
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
      const providerCostUsd = await resolveGenerationCost(
        options?.resolveCost,
        generation,
      );
      await endGeneration({
        traceId: generation.traceId,
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        spanId: generation.spanId,
        providerCostUsd,
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

      const { recordCompletedSpan } = await import("./writer");

      await recordCompletedSpan({
        traceId: span.traceId ?? null,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId ?? null,
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        userId: readAttributeString(attributes, "userId", "user_id"),
        threadId: readAttributeString(attributes, "threadId", "thread_id"),
        messageId: readAttributeString(attributes, "messageId", "message_id"),
        name: span.name,
        kind: "system",
        operation:
          typeof attributes.operation === "string"
            ? attributes.operation
            : span.name,
        provider:
          typeof attributes.provider === "string" ? attributes.provider : null,
        providerModel:
          typeof attributes.providerModel === "string"
            ? attributes.providerModel
            : null,
        modelAlias:
          typeof attributes.modelAlias === "string"
            ? attributes.modelAlias
            : null,
        executionMode:
          typeof attributes.executionMode === "string"
            ? attributes.executionMode
            : null,
        status: span.status,
        startedAt: new Date(span.startedAt),
        endedAt: new Date(span.endedAt),
        errorCode: span.errorCode ?? null,
        errorMessage: span.errorMessage ?? null,
        metadata: buildEventAttributes(attributes),
      });
    },
  };
}

