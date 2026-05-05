import { eq, and } from "drizzle-orm";
import { db } from "../database";
import {
  llmAuditAccessLogs,
  llmGenerations,
  llmSpans,
  llmTraces,
} from "../db/schema";
import { logger } from "../logger";
import {
  createAuditAccessLogId,
  createDatabaseId,
  createGenerationId,
  createSpanId,
  createTraceId,
} from "./ids";
import { applyPayloadPolicyToRecord } from "./payload-policy";
import { redactHeaders, redactRecord } from "./redaction";
import { serializeError, serializeUsage, toJsonRecord } from "./serializers";
import type {
  AuditPayloadMode,
  EndGenerationInput,
  EndSpanInput,
  EndTraceInput,
  RecordAuditAccessInput,
  RecordGenerationErrorInput,
  StartGenerationInput,
  StartSpanInput,
  StartTraceInput,
} from "./types";

function toNumeric(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toFixed(6);
}

function observabilityWritesDisabled() {
  const value =
    process.env.LLM_OBSERVABILITY_WRITES_DISABLED?.trim().toLowerCase();
  return value === "true" || value === "1";
}

function safeErrorSummary(error: unknown) {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    const rawMessage = error.message.split("\n", 1)[0] ?? "";
    const message = rawMessage.startsWith("Failed query:")
      ? "Database write failed"
      : rawMessage.slice(0, 240) || error.name;
    return {
      name: error.name,
      code: typeof maybeCode === "string" ? maybeCode : undefined,
      message,
    };
  }
  return {
    message: String(error).split("\n", 1)[0]?.slice(0, 240) ?? "Unknown error",
  };
}

function resolveLatency(input: {
  startedAt?: Date | null;
  endedAt: Date;
  latencyMs?: number | null;
}) {
  if (input.latencyMs !== undefined) {
    return input.latencyMs;
  }
  if (!input.startedAt) {
    return null;
  }
  return Math.max(0, input.endedAt.getTime() - input.startedAt.getTime());
}

async function safelyWrite<T>(
  operation: string,
  strict: boolean | undefined,
  execute: () => Promise<T>,
): Promise<T | null> {
  if (observabilityWritesDisabled()) {
    return null;
  }

  try {
    return await execute();
  } catch (error) {
    if (strict) {
      throw error;
    }
    logger.warn("LLM observability write failed", {
      operation,
      error: safeErrorSummary(error),
    });
    return null;
  }
}

function policyRecord(value: unknown, mode?: AuditPayloadMode) {
  return value === undefined ? null : applyPayloadPolicyToRecord(value, mode);
}

function policyText(value: string | null | undefined, mode?: AuditPayloadMode) {
  if (value === undefined || value === null) {
    return null;
  }
  const record = applyPayloadPolicyToRecord(value, mode);
  return record ? JSON.stringify(record) : null;
}

function metadataRecord(value: unknown) {
  return redactRecord(value) ?? {};
}

function warnIfNoRowsUpdated(input: {
  operation: string;
  rows: unknown[];
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId?: string;
}) {
  if (input.rows.length > 0) {
    return;
  }
  logger.warn("LLM observability update matched no rows", {
    operation: input.operation,
    traceId: input.traceId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    spanId: input.spanId,
  });
}

async function findTraceStart(input: {
  traceId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .select({ startedAt: llmTraces.startedAt })
    .from(llmTraces)
    .where(
      and(
        eq(llmTraces.traceId, input.traceId),
        eq(llmTraces.teamId, input.teamId),
        eq(llmTraces.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row?.startedAt ?? null;
}

async function findTraceMetadata(input: {
  traceId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .select({ metadataJson: llmTraces.metadataJson })
    .from(llmTraces)
    .where(
      and(
        eq(llmTraces.traceId, input.traceId),
        eq(llmTraces.teamId, input.teamId),
        eq(llmTraces.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row?.metadataJson ?? {};
}

async function findSpanStart(input: {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
}) {
  const [row] = await db
    .select({ startedAt: llmSpans.startedAt })
    .from(llmSpans)
    .where(
      and(
        eq(llmSpans.traceId, input.traceId),
        eq(llmSpans.teamId, input.teamId),
        eq(llmSpans.workspaceId, input.workspaceId),
        eq(llmSpans.spanId, input.spanId),
      ),
    )
    .limit(1);
  return row?.startedAt ?? null;
}

async function findSpanMetadata(input: {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
}) {
  const [row] = await db
    .select({ metadataJson: llmSpans.metadataJson })
    .from(llmSpans)
    .where(
      and(
        eq(llmSpans.traceId, input.traceId),
        eq(llmSpans.teamId, input.teamId),
        eq(llmSpans.workspaceId, input.workspaceId),
        eq(llmSpans.spanId, input.spanId),
      ),
    )
    .limit(1);
  return row?.metadataJson ?? {};
}

async function findGenerationStart(input: {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
}) {
  const [row] = await db
    .select({ startedAt: llmGenerations.startedAt })
    .from(llmGenerations)
    .where(
      and(
        eq(llmGenerations.traceId, input.traceId),
        eq(llmGenerations.teamId, input.teamId),
        eq(llmGenerations.workspaceId, input.workspaceId),
        eq(llmGenerations.spanId, input.spanId),
      ),
    )
    .limit(1);
  return row?.startedAt ?? null;
}

async function findGenerationMetadata(input: {
  traceId: string;
  teamId: string;
  workspaceId: string;
  spanId: string;
}) {
  const [row] = await db
    .select({ metadataJson: llmGenerations.metadataJson })
    .from(llmGenerations)
    .where(
      and(
        eq(llmGenerations.traceId, input.traceId),
        eq(llmGenerations.teamId, input.teamId),
        eq(llmGenerations.workspaceId, input.workspaceId),
        eq(llmGenerations.spanId, input.spanId),
      ),
    )
    .limit(1);
  return row?.metadataJson ?? {};
}

function mergeMetadata(existing: Record<string, unknown>, next: unknown) {
  return {
    ...metadataRecord(existing),
    ...metadataRecord(next),
  };
}

export async function startTrace(input: StartTraceInput) {
  const traceId = input.traceId ?? createTraceId();
  const id = createDatabaseId();
  const startedAt = input.startedAt ?? new Date();

  const result = await safelyWrite("startTrace", input.strict, async () => {
    await db.insert(llmTraces).values({
      id,
      traceId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      threadId: input.threadId ?? null,
      messageId: input.messageId ?? null,
      sessionId: input.sessionId ?? null,
      name: input.name,
      feature: input.feature ?? null,
      inputJson: policyRecord(input.input, input.payloadMode),
      status: "running",
      startedAt,
      tagsJson: input.tags ?? [],
      metadataJson: metadataRecord(input.metadata),
      createdAt: new Date(),
    });
    return { id, traceId };
  });

  return result ?? { id, traceId };
}

export async function endTrace(input: EndTraceInput) {
  const endedAt = input.endedAt ?? new Date();
  await safelyWrite("endTrace", input.strict, async () => {
    const [startedAt, existingMetadata] = await Promise.all([
      findTraceStart(input),
      findTraceMetadata(input),
    ]);
    const rows = await db
      .update(llmTraces)
      .set({
        status: input.status,
        endedAt,
        latencyMs: resolveLatency({
          startedAt,
          endedAt,
          latencyMs: input.latencyMs,
        }),
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        outputJson: policyRecord(input.output, input.payloadMode),
        metadataJson: mergeMetadata(existingMetadata, input.metadata),
      })
      .where(
        and(
          eq(llmTraces.traceId, input.traceId),
          eq(llmTraces.teamId, input.teamId),
          eq(llmTraces.workspaceId, input.workspaceId),
        ),
      )
      .returning({ id: llmTraces.id });
    warnIfNoRowsUpdated({ operation: "endTrace", rows, ...input });
  });
}

export async function startSpan(input: StartSpanInput) {
  const spanId = input.spanId ?? createSpanId();
  const id = createDatabaseId();
  const startedAt = input.startedAt ?? new Date();

  const result = await safelyWrite("startSpan", input.strict, async () => {
    await db.insert(llmSpans).values({
      id,
      traceId: input.traceId,
      spanId,
      parentSpanId: input.parentSpanId ?? null,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      threadId: input.threadId ?? null,
      messageId: input.messageId ?? null,
      name: input.name,
      kind: input.kind,
      operation: input.operation,
      status: "running",
      startedAt,
      inputJson: policyRecord(input.input, input.payloadMode),
      metadataJson: metadataRecord(input.metadata),
      createdAt: new Date(),
    });
    return { id, spanId };
  });

  return result ?? { id, spanId };
}

export async function endSpan(input: EndSpanInput) {
  const endedAt = input.endedAt ?? new Date();
  await safelyWrite("endSpan", input.strict, async () => {
    const [startedAt, existingMetadata] = await Promise.all([
      findSpanStart(input),
      findSpanMetadata(input),
    ]);
    const rows = await db
      .update(llmSpans)
      .set({
        status: input.status,
        endedAt,
        latencyMs: resolveLatency({
          startedAt,
          endedAt,
          latencyMs: input.latencyMs,
        }),
        outputJson: policyRecord(input.output, input.payloadMode),
        metadataJson: mergeMetadata(existingMetadata, input.metadata),
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      })
      .where(
        and(
          eq(llmSpans.traceId, input.traceId),
          eq(llmSpans.teamId, input.teamId),
          eq(llmSpans.workspaceId, input.workspaceId),
          eq(llmSpans.spanId, input.spanId),
        ),
      )
      .returning({ id: llmSpans.id });
    warnIfNoRowsUpdated({ operation: "endSpan", rows, ...input });
  });
}

export async function startGeneration(input: StartGenerationInput) {
  const spanId = input.spanId ?? createGenerationId();
  const id = createDatabaseId();
  const startedAt = input.startedAt ?? new Date();

  const result = await safelyWrite(
    "startGeneration",
    input.strict,
    async () => {
      await db.insert(llmGenerations).values({
        id,
        traceId: input.traceId,
        spanId,
        parentSpanId: input.parentSpanId ?? null,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        threadId: input.threadId ?? null,
        messageId: input.messageId ?? null,
        operation: input.operation,
        modelAlias: input.modelAlias ?? null,
        provider: input.provider ?? null,
        providerModel: input.providerModel ?? null,
        executionMode: input.executionMode ?? null,
        keySource: input.keySource ?? null,
        routeStrategy: input.routeStrategy ?? null,
        routeDecisionJson: toJsonRecord(input.routeDecision),
        modelParametersJson: metadataRecord(input.modelParameters),
        inputJson: policyRecord(input.input, input.payloadMode),
        rawCaptureMode: input.rawCaptureMode ?? "normalized",
        providerRequestJson: policyRecord(
          input.providerRequest,
          input.payloadMode,
        ),
        providerRequestHeadersJson: redactHeaders(input.providerRequestHeaders),
        status: "running",
        startedAt,
        metadataJson: metadataRecord(input.metadata),
        createdAt: new Date(),
      });
      return { id, generationId: id, spanId };
    },
  );

  return result ?? { id, generationId: id, spanId };
}

export async function endGeneration(input: EndGenerationInput) {
  const endedAt = input.endedAt ?? new Date();
  const usage = serializeUsage(input.usage);
  await safelyWrite("endGeneration", input.strict, async () => {
    const [startedAt, existingMetadata] = await Promise.all([
      findGenerationStart(input),
      findGenerationMetadata(input),
    ]);
    const rows = await db
      .update(llmGenerations)
      .set({
        status: input.status ?? "ok",
        endedAt,
        latencyMs: resolveLatency({
          startedAt,
          endedAt,
          latencyMs: input.latencyMs,
        }),
        outputJson: policyRecord(input.output, input.payloadMode),
        outputText: policyText(input.outputText, input.payloadMode),
        finishReason: input.finishReason ?? null,
        reasoningText: policyText(input.reasoningText, input.payloadMode),
        providerFieldsJson: policyRecord(
          input.providerFields,
          input.payloadMode,
        ),
        usageJson: usage,
        inputTokens: input.inputTokens ?? input.usage?.inputTokens ?? null,
        outputTokens: input.outputTokens ?? input.usage?.outputTokens ?? null,
        totalTokens: input.totalTokens ?? input.usage?.totalTokens ?? null,
        providerCostUsd: toNumeric(input.providerCostUsd),
        providerResponseJson: policyRecord(
          input.providerResponse,
          input.payloadMode,
        ),
        providerResponseHeadersJson: redactHeaders(
          input.providerResponseHeaders,
        ),
        providerStatusCode: input.providerStatusCode ?? null,
        providerRequestId: input.providerRequestId ?? null,
        rawCaptureError: input.rawCaptureError ?? null,
        metadataJson: mergeMetadata(existingMetadata, input.metadata),
      })
      .where(
        and(
          eq(llmGenerations.traceId, input.traceId),
          eq(llmGenerations.teamId, input.teamId),
          eq(llmGenerations.workspaceId, input.workspaceId),
          eq(llmGenerations.spanId, input.spanId),
        ),
      )
      .returning({ id: llmGenerations.id });
    warnIfNoRowsUpdated({ operation: "endGeneration", rows, ...input });
  });
}

export async function recordGenerationError(input: RecordGenerationErrorInput) {
  const endedAt = input.endedAt ?? new Date();
  const serialized = serializeError(
    input.error ?? input.errorMessage ?? "Generation failed",
  );
  await safelyWrite("recordGenerationError", input.strict, async () => {
    const [startedAt, existingMetadata] = await Promise.all([
      findGenerationStart(input),
      findGenerationMetadata(input),
    ]);
    const rows = await db
      .update(llmGenerations)
      .set({
        status: "error",
        endedAt,
        latencyMs: resolveLatency({
          startedAt,
          endedAt,
          latencyMs: input.latencyMs,
        }),
        errorCode: input.errorCode ?? serialized.code ?? null,
        errorMessage: input.errorMessage ?? serialized.message,
        providerResponseJson: policyRecord(
          input.providerResponse,
          input.payloadMode,
        ),
        providerStatusCode: input.providerStatusCode ?? null,
        providerRequestId: input.providerRequestId ?? null,
        rawCaptureError: input.rawCaptureError ?? null,
        metadataJson: mergeMetadata(existingMetadata, input.metadata),
      })
      .where(
        and(
          eq(llmGenerations.traceId, input.traceId),
          eq(llmGenerations.teamId, input.teamId),
          eq(llmGenerations.workspaceId, input.workspaceId),
          eq(llmGenerations.spanId, input.spanId),
        ),
      )
      .returning({ id: llmGenerations.id });
    warnIfNoRowsUpdated({ operation: "recordGenerationError", rows, ...input });
  });
}

export async function recordAuditAccess(input: RecordAuditAccessInput) {
  const id = createAuditAccessLogId();
  const result = await safelyWrite(
    "recordAuditAccess",
    input.strict,
    async () => {
      await db.insert(llmAuditAccessLogs).values({
        id,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId ?? null,
        targetType: input.targetType,
        targetId: input.targetId,
        action: input.action,
        metadataJson: metadataRecord(input.metadata),
        createdAt: new Date(),
      });
      return { id };
    },
  );

  return result ?? { id };
}
