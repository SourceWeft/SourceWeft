import { randomUUID } from "node:crypto";
import type {
  GroundedAnchorPort,
  GroundedCheckpointStore,
} from "@sourceweft/contracts/grounded-generation";
import type {
  TableColumnInput,
  TableContent,
  TableStats,
} from "@sourceweft/contracts/table";
import type {
  TableCheckpoint,
  TableFigurePort,
  TableGenerationMembers,
  TableModelPort,
  TableOperation,
  TableSourceInput,
} from "@sourceweft/contracts/table-capability";
import {
  estimateTokens,
  resolveOutputLanguage,
} from "@sourceweft/grounded-generation";
import { completeEmbeddingBatch } from "../../shared/model-gateway/index";
import { logger } from "../../shared/logger";
import { CITATION_ANCHORING_FEATURE } from "../citations/anchoring-diagnostics";
import { figuresCovered } from "../citations/figures";
import type { ContentBillingPort } from "../content/billing-port";
import { createGroundedAnchorPort } from "../grounded-generation/anchor-port";
import type { GroundedSourceSnapshot } from "../grounded-generation/corpus-loader";
import {
  createGroundedModelPort,
  describeDefaultChatModel,
} from "../grounded-generation/model-port";
import { resolveRequesterPayer } from "../grounded-generation/payer";
import type { GuidePayer, GuidePayerPorts } from "../sources/guide-payer";
import { loadTableGeneration } from "./capability";
import { loadTableSources, type TableSources } from "./corpus-loader";
import { loadSourceSummaries, type SourceSummary } from "./summaries";

const SUBJECT = "table";

type ModelPortInput = {
  payer: GuidePayer;
  teamId: string;
  workspaceId: string;
  userId: string;
  /** What the call is billed under: the queue job id, or a request id. */
  scopeId: string;
};

/**
 * The output language of a table: the request's, else the language most of the
 * sources' text is in, else the requester's UI language.
 */
export function resolveTableLanguage(input: {
  requested?: string | undefined;
  sources: readonly TableSourceInput[];
  uiLocale: string;
}): string {
  return resolveOutputLanguage({
    requested: input.requested ?? null,
    chunks: input.sources.flatMap((source) =>
      source.chunks.map((chunk) => ({
        language: chunk.language,
        tokens: estimateTokens(chunk.text),
      })),
    ),
    uiLocale: input.uiLocale,
  });
}

/* -------------------------------------------------------------- suggestion */

export type SuggestTableColumnsRequest = {
  /** The workspace's organization. */
  teamId: string;
  workspaceId: string;
  /** Who asked; always the payer. */
  userId: string;
  sourceIds: string[];
  /** The user's own words about what the table is for. */
  instruction?: string;
  language?: string;
  uiLocale: string;
};

export type SuggestTableColumnsDeps = {
  billing: ContentBillingPort;
  /** The engine; loaded from the table capability when omitted. */
  generation?: TableGenerationMembers;
  payerPorts?: GuidePayerPorts;
  loadSummaries?: typeof loadSourceSummaries;
  describeModel?: () => Promise<{ modelAlias: string }>;
  createModelPort?: (input: ModelPortInput) => TableModelPort;
};

function defaultModelPort(
  deps: { billing: ContentBillingPort },
  input: ModelPortInput,
  scopeKind: "worker-job" | "api-request",
): TableModelPort {
  return createGroundedModelPort<TableOperation>({
    billing: deps.billing,
    teamId: input.payer.billingOrganizationId,
    workspaceId: input.workspaceId,
    actorUserId: input.payer.userId,
    scopeId: input.scopeId,
    scopeKind,
    subject: SUBJECT,
  });
}

/**
 * Proposes the columns of a table from the sources' summaries: resolves who
 * pays (the requester, or nobody), checks the default model, reads the
 * summaries as that workspace's sources and makes one billed model call, in
 * the request's scope. Throws `TableGenerationError` with the failure's code.
 */
export async function suggestTableColumns(
  request: SuggestTableColumnsRequest,
  deps: SuggestTableColumnsDeps,
): Promise<TableColumnInput[]> {
  const payer = await resolveRequesterPayer(
    {
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      userId: request.userId,
      subject: SUBJECT,
    },
    ...(deps.payerPorts ? [deps.payerPorts] : []),
  );
  await (deps.describeModel ?? describeDefaultChatModel)();
  const summaries: SourceSummary[] = await (deps.loadSummaries ?? loadSourceSummaries)({
    teamId: request.teamId,
    workspaceId: request.workspaceId,
    sourceIds: request.sourceIds,
  });
  const generation = deps.generation ?? (await loadTableGeneration());

  // One request, one scope: the billing key never collides with another
  // suggestion, so each is charged once and only once.
  const scopeId = `table-suggest_${randomUUID()}`;
  const input: ModelPortInput = {
    payer,
    teamId: request.teamId,
    workspaceId: request.workspaceId,
    userId: request.userId,
    scopeId,
  };
  const model = deps.createModelPort
    ? deps.createModelPort(input)
    : defaultModelPort(deps, input, "api-request");
  const instruction = request.instruction?.trim();
  const columns = await generation.suggestColumns(
    { model },
    {
      referenceId: `table-suggest:${request.workspaceId}`,
      idempotencyKey: `table.columns.suggest:${scopeId}`,
      ...(instruction ? { instruction } : {}),
      language: request.language?.trim() || request.uiLocale,
      sources: summaries.map(({ title, summary }) => ({ title, summary })),
    },
  );
  logger.info("Table columns suggested", {
    workspaceId: request.workspaceId,
    sources: summaries.length,
    columns: columns.length,
    payerUserId: payer.userId,
  });
  return columns;
}

/* -------------------------------------------------------------- generation */

export type TableGenerationRequest = {
  /** The workspace's organization. */
  teamId: string;
  workspaceId: string;
  threadId: string;
  artifactId: string;
  versionNo: number;
  /** Who asked; always the payer. */
  userId: string;
  sourceIds: string[];
  columns: TableColumnInput[];
  instruction?: string;
  /** BCP 47 tag; omitted means follow the sources. */
  language?: string;
  /** UI locale of the requester, for the output language when sources are mixed. */
  uiLocale: string;
  /** The previous version, whose unchanged cells are reused. */
  previous?: TableContent;
  /** Billing scope: the queue job id. */
  scopeId: string;
};

export type TableGenerationDeps = {
  billing: ContentBillingPort;
  /** The engine; loaded from the table capability when omitted. */
  generation?: TableGenerationMembers;
  payerPorts?: GuidePayerPorts;
  loadSources?: typeof loadTableSources;
  describeModel?: () => Promise<{ modelAlias: string }>;
  createModelPort?: (input: ModelPortInput) => TableModelPort;
  createAnchorPort?: (input: { payer: GuidePayer; request: TableGenerationRequest }) => GroundedAnchorPort;
  figures?: TableFigurePort;
  checkpoint?: GroundedCheckpointStore<TableCheckpoint>;
  onProgress?: (progress: {
    stage: "fill" | "finalize";
    done: number;
    total: number;
  }) => void | Promise<void>;
  signal?: AbortSignal;
};

export type TableGenerationOutcome = {
  content: TableContent;
  stats: TableStats;
  payer: GuidePayer;
  sources: GroundedSourceSnapshot[];
  durationMs: number;
};

/**
 * Generates the content of one table version: resolves who pays (the
 * requester, or nobody), checks the default model, loads the selected sources
 * as that workspace's, and runs the engine with the host's model, anchor and
 * figure ports under the job's time budget. Throws `TableGenerationError` with
 * the failure's code; the caller decides how the artifact records it.
 */
export async function runTableGeneration(
  request: TableGenerationRequest,
  deps: TableGenerationDeps,
): Promise<TableGenerationOutcome> {
  const startedAt = Date.now();
  const payer = await resolveRequesterPayer(
    {
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      userId: request.userId,
      subject: SUBJECT,
    },
    ...(deps.payerPorts ? [deps.payerPorts] : []),
  );
  const { modelAlias } = await (deps.describeModel ?? describeDefaultChatModel)();
  const loaded: TableSources = await (deps.loadSources ?? loadTableSources)({
    teamId: request.teamId,
    workspaceId: request.workspaceId,
    sourceIds: request.sourceIds,
  });

  const generation = deps.generation ?? (await loadTableGeneration());
  const columns = generation.resolveColumns(request.columns, request.previous?.columns);
  const language = resolveTableLanguage({
    requested: request.language,
    sources: loaded.sources,
    uiLocale: request.uiLocale,
  });
  const instruction = request.instruction?.trim();

  const modelInput: ModelPortInput = {
    payer,
    teamId: request.teamId,
    workspaceId: request.workspaceId,
    userId: request.userId,
    scopeId: request.scopeId,
  };
  const model = deps.createModelPort
    ? deps.createModelPort(modelInput)
    : defaultModelPort(deps, modelInput, "worker-job");
  const anchor = deps.createAnchorPort
    ? deps.createAnchorPort({ payer, request })
    : createGroundedAnchorPort({
        // The by-meaning pass for cross-language evidence: recorded, not
        // charged, like citation anchoring in chat.
        embedTexts: (texts) =>
          completeEmbeddingBatch({
            billing: deps.billing,
            teamId: payer.billingOrganizationId,
            workspaceId: request.workspaceId,
            actorUserId: payer.userId,
            threadId: request.threadId,
            scopeId: request.scopeId,
            feature: CITATION_ANCHORING_FEATURE,
            idempotencyKey: `table:${request.artifactId}:v${request.versionNo}:anchor`,
            texts,
          }),
        onSemanticError: (error) =>
          logger.warn("Table evidence by-meaning anchoring failed", {
            err: error,
            artifactId: request.artifactId,
          }),
      });

  const budget = AbortSignal.timeout(generation.limits.jobTimeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, budget]) : budget;

  const result = await generation.fillTable(
    {
      model,
      anchor,
      figures: deps.figures ?? { covered: figuresCovered },
      signal,
      ...(deps.checkpoint ? { checkpoint: deps.checkpoint } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    },
    {
      artifactId: request.artifactId,
      versionNo: request.versionNo,
      columns,
      sources: loaded.sources,
      language,
      ...(instruction ? { instruction } : {}),
      modelAlias,
      ...(request.previous ? { previous: request.previous } : {}),
      // What "adjust and regenerate" starts from. The ids are the table's own,
      // so the next regeneration keeps each column and its viewer settings.
      recipe: {
        ...(instruction ? { instruction } : {}),
        columns: columns.map(({ id, name, description, type }) => ({
          id,
          name,
          ...(description ? { description } : {}),
          type,
        })),
        sourceIds: request.sourceIds,
      },
    },
  );
  const durationMs = Date.now() - startedAt;
  // Counts and identifiers only: never source text or cell content.
  logger.info("Table artifact generated", {
    artifactId: request.artifactId,
    versionNo: request.versionNo,
    sources: result.stats.sources,
    columns: result.stats.columns,
    found: result.stats.found,
    notFound: result.stats.notFound,
    unverified: result.stats.unverified,
    reusedCells: result.stats.reusedCells,
    failedRows: result.stats.failedRows,
    skippedRows: result.stats.skippedRows,
    modelCalls: result.stats.modelCalls,
    inputTokensEstimated: result.stats.tokensEstimated,
    durationMs,
    payerUserId: payer.userId,
    modelAlias,
    promptVersion: result.content.generation.promptVersion,
  });
  return { ...result, payer, sources: loaded.snapshots, durationMs };
}
