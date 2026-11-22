import { createHash } from "node:crypto";
import {
  chunks as chunksTable,
  database,
  db,
  documents,
  sources,
  threads,
  workspaceMemberships,
  workspaces,
} from "@sourceweft/db";
import type {
  BillingRuntime,
  SettleModelUsageInput,
} from "@sourceweft/contracts/billing-runtime";
import type { StudyContent, StudyKind } from "@sourceweft/contracts/study";
import type {
  StudyGenerationStats,
  StudyModelPort,
} from "@sourceweft/contracts/study-capability";
import { completeStructuredWithDefaultChat } from "../../../shared/model-gateway/index";
import { createStudyModelPort } from "../model-port";
import { runStudyGeneration } from "../service";
import { chunkLanguage, type StudyEvalFixture } from "./fixtures";
import {
  judgeContent,
  STUDY_EVAL_JUDGE_OPERATION,
  type JudgeVerdict,
} from "./judge";

/**
 * Runs evaluation fixtures through the real study generation: the fixture is
 * stored as an indexed source in the database `DATABASE_URL` names, and
 * `runStudyGeneration` loads it, resolves the payer, calls the default chat
 * model through the billed model port and anchors evidence through the real
 * anchor port (with its by-meaning pass). Nothing is stubbed. The runner only
 * observes: a recording billing runtime keeps every settled call's usage and
 * cost, and the model port is wrapped to time and count calls.
 */

/** One settled model call, as the billing port saw it. */
export type UsageRecord = {
  operation: string;
  feature: string;
  idempotencyKey: string | null;
  referenceId: string | null;
  profileAlias: string;
  modelAlias: string | null;
  /** The provider's model id the route reached, when the gateway reported it. */
  providerModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  costSource: string;
};

function numberOr0(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Wraps the deployment's billing runtime: resolves each call's cost once,
 * records it with the call's token usage, and hands the resolved cost on to
 * the real runtime unchanged.
 */
export function createRecordingBilling(inner: BillingRuntime): {
  billing: BillingRuntime;
  records: UsageRecord[];
} {
  const records: UsageRecord[] = [];
  const billing: BillingRuntime = {
    getExecutionState: (...args) => inner.getExecutionState(...args),
    meterIngestion: (...args) => inner.meterIngestion(...args),
    getScheduledTaskLimits: (...args) => inner.getScheduledTaskLimits(...args),
    reconcileProviderCost: (...args) => inner.reconcileProviderCost(...args),
    async settleModelUsage(input: SettleModelUsageInput) {
      const cost = typeof input.cost === "function" ? await input.cost() : input.cost;
      const usage = (input.metadata?.usage ?? {}) as Record<string, unknown>;
      records.push({
        operation: input.operation,
        feature: input.feature,
        idempotencyKey: input.idempotencyKey ?? null,
        referenceId: input.referenceId ?? null,
        profileAlias: input.profileAlias,
        modelAlias: input.modelAlias ?? null,
        providerModel:
          typeof input.metadata?.providerModel === "string"
            ? input.metadata.providerModel
            : null,
        inputTokens: numberOr0(usage.inputTokens),
        outputTokens: numberOr0(usage.outputTokens),
        cacheReadTokens: numberOr0(usage.cacheReadTokens),
        costUsd: input.providerActualCostUsd ?? cost.providerCostUsd,
        costSource: input.providerActualCostUsd != null
          ? (input.providerCostSource ?? "provider_reported")
          : cost.costSource,
      });
      return inner.settleModelUsage({ ...input, cost });
    },
  };
  return { billing, records };
}

/** The fixed principal every evaluation run acts as. */
export const STUDY_EVAL_PRINCIPAL = {
  teamId: "study-eval-org",
  workspaceId: "study-eval-workspace",
  userId: "study-eval-user",
  threadId: "study-eval-thread",
} as const;

/** Creates the evaluation organization, user, workspace and thread once. */
export async function ensureEvalPrincipal() {
  const p = STUDY_EVAL_PRINCIPAL;
  await database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now()) on conflict do nothing',
    [p.teamId],
  );
  await db
    .insert(workspaces)
    .values({ id: p.workspaceId, organizationId: p.teamId, name: "Study evaluation", slug: p.workspaceId })
    .onConflictDoNothing();
  await database.query(
    'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1,$1,$2,true,now(),now()) on conflict do nothing',
    [p.userId, `${p.userId}@example.test`],
  );
  await db
    .insert(workspaceMemberships)
    .values({ workspaceId: p.workspaceId, userId: p.userId, role: "editor", source: "guest" })
    .onConflictDoNothing();
  await db
    .insert(threads)
    .values({
      id: p.threadId,
      teamId: p.teamId,
      workspaceId: p.workspaceId,
      title: "Study evaluation",
      visibility: "private",
      createdBy: p.userId,
    })
    .onConflictDoNothing();
}

export type SeededFixture = {
  sourceId: string;
  /** Chunk id → stored text, for the metrics and the judge. */
  chunkTextById: Map<string, string>;
  chunkRows: { chunkId: string; headingPath: string | null }[];
};

/** Stores one fixture as an indexed source of the evaluation workspace. */
export async function seedFixture(
  fixture: StudyEvalFixture,
  runId: string,
): Promise<SeededFixture> {
  const p = STUDY_EVAL_PRINCIPAL;
  const sourceId = `src_eval_${runId}_${fixture.id}`;
  const documentId = `doc_eval_${runId}_${fixture.id}`;
  const fullText = fixture.chunks.map((chunk) => chunk.text).join("\n\n");
  const contentHash = createHash("sha256").update(fullText).digest("hex");
  await db.insert(sources).values({
    id: sourceId,
    teamId: p.teamId,
    workspaceId: p.workspaceId,
    title: fixture.title,
    contentText: fullText,
    contentHash,
    status: "indexed",
  });
  await db.insert(documents).values({
    id: documentId,
    teamId: p.teamId,
    workspaceId: p.workspaceId,
    sourceId,
    contentText: fullText,
    status: "ready",
  });
  const rows = fixture.chunks.map((chunk) => ({
    id: `chk_eval_${runId}_${fixture.id}_${chunk.chunkNo}`,
    teamId: p.teamId,
    workspaceId: p.workspaceId,
    sourceId,
    documentId,
    chunkNo: chunk.chunkNo,
    content: chunk.text,
    headingPath: chunk.headingPath,
    language: chunkLanguage(fixture, chunk),
  }));
  await db.insert(chunksTable).values(rows);
  return {
    sourceId,
    chunkTextById: new Map(rows.map((row) => [row.id, row.content])),
    chunkRows: rows.map((row) => ({ chunkId: row.id, headingPath: row.headingPath })),
  };
}

export type ModelCallRecord = {
  operation: string;
  schemaName: string;
  durationMs: number;
  ok: boolean;
  error?: string;
};

function recordingModelPort(
  port: StudyModelPort,
  calls: ModelCallRecord[],
): StudyModelPort {
  return {
    async completeStructured(call) {
      const startedAt = Date.now();
      try {
        const result = await port.completeStructured(call);
        calls.push({
          operation: call.operation,
          schemaName: call.schema.name,
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return result;
      } catch (error) {
        calls.push({
          operation: call.operation,
          schemaName: call.schema.name,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export type EvalJobRecord = {
  fixtureId: string;
  category: StudyEvalFixture["category"];
  kind: StudyKind;
  artifactId: string;
  status: "ready" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: Record<string, unknown> | null;
  durationMs: number;
  mode: "single" | "mapreduce" | null;
  stats: StudyGenerationStats | null;
  content: StudyContent | null;
  calls: ModelCallRecord[];
  judge: { verdicts: JudgeVerdict[]; skippedWithoutEvidence: number } | null;
};

function errorFields(error: unknown) {
  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  const details =
    typeof error === "object" && error !== null && typeof (error as { details?: unknown }).details === "object"
      ? ((error as { details: Record<string, unknown> }).details ?? null)
      : null;
  return {
    errorCode: code,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorDetails: details,
  };
}

/** Generates one fixture as one study type through the real backend path. */
export async function runFixtureKind(input: {
  fixture: StudyEvalFixture;
  seeded: SeededFixture;
  kind: StudyKind;
  runId: string;
  billing: BillingRuntime;
}): Promise<EvalJobRecord> {
  const { fixture, kind, runId } = input;
  const artifactId = `study-eval-${runId}-${fixture.id}-${kind}`;
  const calls: ModelCallRecord[] = [];
  const startedAt = Date.now();
  const base = {
    fixtureId: fixture.id,
    category: fixture.category,
    kind,
    artifactId,
    calls,
    judge: null,
  };
  try {
    const outcome = await runStudyGeneration(
      {
        teamId: STUDY_EVAL_PRINCIPAL.teamId,
        workspaceId: STUDY_EVAL_PRINCIPAL.workspaceId,
        threadId: STUDY_EVAL_PRINCIPAL.threadId,
        artifactId,
        versionNo: 1,
        userId: STUDY_EVAL_PRINCIPAL.userId,
        kind,
        sourceIds: [input.seeded.sourceId],
        options: {
          ...(fixture.outputLanguage ? { language: fixture.outputLanguage } : {}),
          ...(fixture.focus ? { focus: fixture.focus } : {}),
        },
        uiLocale: fixture.uiLocale,
        scopeId: `study-eval:${runId}:${fixture.id}:${kind}`,
      },
      {
        billing: input.billing,
        // The production model port, observed: same arguments as the default.
        createModelPort: ({ payer, request }) =>
          recordingModelPort(
            createStudyModelPort({
              billing: input.billing,
              teamId: payer.billingOrganizationId,
              workspaceId: request.workspaceId,
              actorUserId: payer.userId,
              scopeId: request.scopeId,
            }),
            calls,
          ),
      },
    );
    return {
      ...base,
      status: "ready",
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
      durationMs: Date.now() - startedAt,
      mode: outcome.mode,
      stats: outcome.stats,
      content: outcome.content,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      ...errorFields(error),
      durationMs: Date.now() - startedAt,
      mode: null,
      stats: null,
      content: null,
    };
  }
}

/**
 * Judges a ready job with the deployment's default chat profile (the only
 * existing profile the study path may use; see the report for the
 * self-assessment caveat), billed like any other call.
 */
export async function judgeJob(input: {
  record: EvalJobRecord;
  seeded: SeededFixture;
  runId: string;
  billing: BillingRuntime;
  concurrency?: number;
}): Promise<EvalJobRecord["judge"]> {
  if (!input.record.content) return null;
  const p = STUDY_EVAL_PRINCIPAL;
  return judgeContent({
    content: input.record.content,
    chunkTextById: input.seeded.chunkTextById,
    keyRoot: `study-eval:${input.runId}:judge:${input.record.artifactId}`,
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    call: (call) =>
      completeStructuredWithDefaultChat({
        billing: input.billing,
        teamId: p.teamId,
        workspaceId: p.workspaceId,
        actorUserId: p.userId,
        scopeId: `study-eval:${input.runId}:judge`,
        scopeKind: "worker-job",
        operation: STUDY_EVAL_JUDGE_OPERATION,
        referenceId: `study-eval:${input.runId}:judge`,
        idempotencyKey: call.key,
        system: call.system,
        user: call.user,
        schema: call.schema,
        maxTokens: call.maxTokens,
      }),
  });
}
