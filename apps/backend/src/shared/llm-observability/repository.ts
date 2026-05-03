import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "../database";
import {
  llmGenerations,
  llmSpans,
  llmTraces,
} from "../db/schema";

type TraceListInput = {
  teamId: string;
  workspaceId?: string;
  from?: Date;
  to?: Date;
  userId?: string;
  threadId?: string;
  messageId?: string;
  feature?: string;
  status?: string;
  cursor?: Date;
  limit: number;
};

type GenerationListInput = TraceListInput & {
  operation?: string;
  provider?: string;
  modelAlias?: string;
};

type UserDisplayRow = {
  id: string;
  name: string | null;
  email: string | null;
};

function cursorValue(value: Date | string | number | null | undefined) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function traceFilters(input: TraceListInput) {
  return [
    eq(llmTraces.teamId, input.teamId),
    input.workspaceId ? eq(llmTraces.workspaceId, input.workspaceId) : undefined,
    input.from ? gte(llmTraces.startedAt, input.from) : undefined,
    input.to ? lte(llmTraces.startedAt, input.to) : undefined,
    input.userId ? eq(llmTraces.userId, input.userId) : undefined,
    input.threadId ? eq(llmTraces.threadId, input.threadId) : undefined,
    input.messageId ? eq(llmTraces.messageId, input.messageId) : undefined,
    input.feature ? eq(llmTraces.feature, input.feature) : undefined,
    input.status ? eq(llmTraces.status, input.status as never) : undefined,
    input.cursor ? lt(llmTraces.startedAt, input.cursor) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
}

function generationFilters(input: GenerationListInput) {
  return [
    eq(llmGenerations.teamId, input.teamId),
    input.workspaceId ? eq(llmGenerations.workspaceId, input.workspaceId) : undefined,
    input.from ? gte(llmGenerations.startedAt, input.from) : undefined,
    input.to ? lte(llmGenerations.startedAt, input.to) : undefined,
    input.userId ? eq(llmGenerations.userId, input.userId) : undefined,
    input.threadId ? eq(llmGenerations.threadId, input.threadId) : undefined,
    input.messageId ? eq(llmGenerations.messageId, input.messageId) : undefined,
    input.status ? eq(llmGenerations.status, input.status as never) : undefined,
    input.cursor ? lt(llmGenerations.startedAt, input.cursor) : undefined,
    input.operation ? eq(llmGenerations.operation, input.operation) : undefined,
    input.provider ? eq(llmGenerations.provider, input.provider) : undefined,
    input.modelAlias ? eq(llmGenerations.modelAlias, input.modelAlias) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
}

function generationModel(generation: { providerModel: string | null; modelAlias: string | null }) {
  return generation.modelAlias ?? generation.providerModel ?? null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsageTotalTokens(value: unknown): number | null {
  const record = unwrapPayloadRecord(value);
  if (!record) return null;
  const directUsage = toRecord(record.usage);
  const usage = directUsage ?? record;
  return readNumber(usage.totalTokens) ?? readNumber(usage.total_tokens);
}

function unwrapPayloadRecord(value: unknown): Record<string, unknown> | null {
  const record = toRecord(value);
  if (!record) return null;
  return toRecord(record.value) ?? record;
}

function spanModel(span: {
  metadataJson: Record<string, unknown>;
  inputJson: Record<string, unknown> | null;
  outputJson: Record<string, unknown> | null;
}) {
  return readString(span.metadataJson.modelAlias)
    ?? readString(span.metadataJson.model)
    ?? readString(unwrapPayloadRecord(span.inputJson)?.modelAlias)
    ?? readString(unwrapPayloadRecord(span.inputJson)?.model)
    ?? readString(unwrapPayloadRecord(span.outputJson)?.modelAlias)
    ?? readString(unwrapPayloadRecord(span.outputJson)?.model);
}

function spanTotalTokens(span: {
  inputJson: Record<string, unknown> | null;
  outputJson: Record<string, unknown> | null;
}) {
  return readUsageTotalTokens(span.outputJson) ?? readUsageTotalTokens(span.inputJson);
}

function traceMetadataModel(trace: { metadataJson: Record<string, unknown> }) {
  return readString(trace.metadataJson.modelAlias) ?? readString(trace.metadataJson.model);
}

async function summarizeTraceObservations(traces: Array<typeof llmTraces.$inferSelect>) {
  const traceIds = traces.map((trace) => trace.traceId);
  if (traceIds.length === 0) {
    return new Map<string, { observationCount: number; totalTokens: number | null; model: string | null }>();
  }

  const [spans, generations] = await Promise.all([
    db
      .select({
        traceId: llmSpans.traceId,
        metadataJson: llmSpans.metadataJson,
        inputJson: llmSpans.inputJson,
        outputJson: llmSpans.outputJson,
      })
      .from(llmSpans)
      .where(inArray(llmSpans.traceId, traceIds)),
    db
      .select({
        traceId: llmGenerations.traceId,
        modelAlias: llmGenerations.modelAlias,
        providerModel: llmGenerations.providerModel,
        totalTokens: llmGenerations.totalTokens,
        startedAt: llmGenerations.startedAt,
      })
      .from(llmGenerations)
      .where(inArray(llmGenerations.traceId, traceIds))
      .orderBy(llmGenerations.startedAt),
  ]);

  const summary = new Map<string, { observationCount: number; totalTokens: number; model: string | null }>();
  const spanTokenTotals = new Map<string, number>();
  for (const traceId of traceIds) {
    const trace = traces.find((item) => item.traceId === traceId);
    summary.set(traceId, {
      observationCount: 0,
      totalTokens: 0,
      model: trace ? traceMetadataModel(trace) : null,
    });
  }
  for (const span of spans) {
    const item = summary.get(span.traceId);
    if (!item) continue;
    item.observationCount += 1;
    item.model ??= spanModel(span);
    spanTokenTotals.set(
      span.traceId,
      (spanTokenTotals.get(span.traceId) ?? 0) + (spanTotalTokens(span) ?? 0),
    );
  }
  for (const generation of generations) {
    const item = summary.get(generation.traceId);
    if (!item) continue;
    item.observationCount += 1;
    item.totalTokens += generation.totalTokens ?? 0;
    item.model ??= generationModel(generation);
  }

  for (const [traceId, spanTokens] of spanTokenTotals) {
    const item = summary.get(traceId);
    if (item && item.totalTokens === 0) {
      item.totalTokens = spanTokens;
    }
  }

  return new Map(
    Array.from(summary.entries()).map(([traceId, item]) => [
      traceId,
      {
        observationCount: item.observationCount,
        totalTokens: item.totalTokens > 0 ? item.totalTokens : null,
        model: item.model,
      },
    ]),
  );
}

async function getTraceUserDisplayNames(traces: Array<typeof llmTraces.$inferSelect>) {
  const userIds = Array.from(new Set(traces.map((trace) => trace.userId).filter((userId): userId is string => Boolean(userId))));
  if (userIds.length === 0) {
    return new Map<string, string>();
  }

  const rows = await db.execute<UserDisplayRow>(sql`
    select id, name, email
    from "user"
    where id in ${userIds}
  `);

  return new Map(
    (rows.rows ?? []).map((row) => [
      row.id,
      (row.name && row.name.trim()) || (row.email && row.email.trim()) || row.id,
    ]),
  );
}

export async function listLlmTraces(input: TraceListInput) {
  const rows = await db
    .select()
    .from(llmTraces)
    .where(and(...traceFilters(input)))
    .orderBy(desc(llmTraces.startedAt))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const [observationSummaries, userDisplayNames] = await Promise.all([
    summarizeTraceObservations(items),
    getTraceUserDisplayNames(items),
  ]);
  return {
    items: items.map((trace) => ({
      ...trace,
      userDisplayName: trace.userId ? userDisplayNames.get(trace.userId) ?? null : null,
      ...(observationSummaries.get(trace.traceId) ?? {
        observationCount: 0,
        totalTokens: null,
        model: null,
      }),
    })),
    nextCursor: hasMore ? cursorValue(items.at(-1)?.startedAt) : null,
  };
}

export async function getLlmTrace(input: {
  teamId: string;
  workspaceId?: string;
  traceId: string;
}) {
  const [trace] = await db
    .select()
    .from(llmTraces)
    .where(
      and(
        eq(llmTraces.teamId, input.teamId),
        input.workspaceId ? eq(llmTraces.workspaceId, input.workspaceId) : undefined,
        eq(llmTraces.traceId, input.traceId),
      ),
    )
    .limit(1);

  if (!trace) {
    return null;
  }

  const [spans, generations] = await Promise.all([
    db
      .select()
      .from(llmSpans)
      .where(and(eq(llmSpans.teamId, input.teamId), eq(llmSpans.traceId, input.traceId)))
      .orderBy(llmSpans.startedAt),
    db
      .select()
      .from(llmGenerations)
      .where(and(eq(llmGenerations.teamId, input.teamId), eq(llmGenerations.traceId, input.traceId)))
      .orderBy(llmGenerations.startedAt),
  ]);

  const userDisplayNames = await getTraceUserDisplayNames([trace]);
  const observationSummaries = await summarizeTraceObservations([trace]);

  return {
    trace: {
      ...trace,
      userDisplayName: trace.userId ? userDisplayNames.get(trace.userId) ?? null : null,
      ...(observationSummaries.get(trace.traceId) ?? {
        observationCount: spans.length + generations.length,
        totalTokens: null,
        model: traceMetadataModel(trace),
      }),
    },
    spans,
    generations,
  };
}

export async function listLlmGenerations(input: GenerationListInput) {
  const rows = await db
    .select()
    .from(llmGenerations)
    .where(and(...generationFilters(input)))
    .orderBy(desc(llmGenerations.startedAt))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    items,
    nextCursor: hasMore ? cursorValue(items.at(-1)?.startedAt) : null,
  };
}

export async function getLlmGeneration(input: {
  teamId: string;
  workspaceId?: string;
  generationId: string;
}) {
  const [generation] = await db
    .select()
    .from(llmGenerations)
    .where(
      and(
        eq(llmGenerations.teamId, input.teamId),
        input.workspaceId ? eq(llmGenerations.workspaceId, input.workspaceId) : undefined,
        eq(llmGenerations.id, input.generationId),
      ),
    )
    .limit(1);

  return generation ?? null;
}

export async function getLlmSpan(input: {
  teamId: string;
  workspaceId?: string;
  spanId: string;
}) {
  const [span] = await db
    .select()
    .from(llmSpans)
    .where(
      and(
        eq(llmSpans.teamId, input.teamId),
        input.workspaceId ? eq(llmSpans.workspaceId, input.workspaceId) : undefined,
        eq(llmSpans.spanId, input.spanId),
      ),
    )
    .limit(1);

  return span ?? null;
}
