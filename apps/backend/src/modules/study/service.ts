import type {
  StudyKind,
  StudyOptions,
} from "@sourceweft/contracts/study";
import { completeEmbeddingBatch } from "../../shared/model-gateway/index";
import { logger } from "../../shared/logger";
import { CITATION_ANCHORING_FEATURE } from "../citations/anchoring-diagnostics";
import type { ContentBillingPort } from "../content/billing-port";
import type { GuidePayer, GuidePayerPorts } from "../sources/guide-payer";
import { createStudyAnchorPort } from "./anchor-port";
import {
  loadStudyCorpus,
  type StudyCorpus,
  type StudySourceSnapshot,
} from "./corpus-loader";
import {
  estimateTokens,
  generateStudyContent,
  resolveStudyOptions,
  SINGLE_PASS_MAX_INPUT_TOKENS,
  STUDY_JOB_TIMEOUT_MS,
  type StudyAnchorPort,
  type StudyCheckpointStore,
  type StudyContentResult,
  type StudyModelPort,
  type StudyProgress,
} from "./engine";
import { createStudyModelPort, describeStudyModel } from "./model-port";
import { resolveStudyPayer } from "./payer";

export type StudyGenerationRequest = {
  /** The workspace's organization. */
  teamId: string;
  workspaceId: string;
  threadId: string;
  artifactId: string;
  versionNo: number;
  /** Who asked; always the payer. */
  userId: string;
  kind: StudyKind;
  sourceIds: string[];
  options?: StudyOptions;
  /** UI locale of the requester, for the output language when sources are mixed. */
  uiLocale: string;
  /** Previous version's items, so unchanged items keep their ids. */
  previousIds?: ReadonlyMap<string, string>;
  /** Billing scope: the queue job id. */
  scopeId: string;
};

export type StudyGenerationDeps = {
  billing: ContentBillingPort;
  payerPorts?: GuidePayerPorts;
  loadCorpus?: typeof loadStudyCorpus;
  describeModel?: () => Promise<{ modelAlias: string }>;
  createModelPort?: (input: {
    payer: GuidePayer;
    request: StudyGenerationRequest;
  }) => StudyModelPort;
  createAnchorPort?: (input: {
    payer: GuidePayer;
    request: StudyGenerationRequest;
  }) => StudyAnchorPort;
  checkpoint?: StudyCheckpointStore;
  onProgress?: (progress: StudyProgress) => void | Promise<void>;
  signal?: AbortSignal;
};

export type StudyGenerationOutcome = StudyContentResult & {
  payer: GuidePayer;
  sources: StudySourceSnapshot[];
  durationMs: number;
};

function rootLabelOf(sources: readonly StudySourceSnapshot[]) {
  const first = sources[0]?.title.trim() || "Sources";
  return sources.length > 1 ? `${first} +${sources.length - 1}` : first;
}

function corpusMode(corpus: StudyCorpus) {
  const tokens = corpus.chunks.reduce(
    (sum, chunk) => sum + estimateTokens(chunk.text),
    0,
  );
  return tokens <= SINGLE_PASS_MAX_INPUT_TOKENS ? "single" : "mapreduce";
}

/**
 * Generates the content of one study artifact version: resolves who pays (the
 * requester, or nobody), checks the default model, loads the corpus as that
 * workspace's sources, and runs the engine with the host's model and anchor
 * ports under the job's time budget. Throws `StudyGenerationError` with the
 * failure's code; the caller decides how the artifact records it.
 */
export async function runStudyGeneration(
  request: StudyGenerationRequest,
  deps: StudyGenerationDeps,
): Promise<StudyGenerationOutcome> {
  const startedAt = Date.now();
  const payer = await resolveStudyPayer(
    {
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      userId: request.userId,
    },
    ...(deps.payerPorts ? [deps.payerPorts] : []),
  );
  const { modelAlias } = await (deps.describeModel ?? describeStudyModel)();
  const corpus = await (deps.loadCorpus ?? loadStudyCorpus)({
    teamId: request.teamId,
    workspaceId: request.workspaceId,
    sourceIds: request.sourceIds,
  });

  const options = resolveStudyOptions({
    kind: request.kind,
    ...(request.options ? { options: request.options } : {}),
    chunks: corpus.chunks,
    uiLocale: request.uiLocale,
  });
  const model = deps.createModelPort
    ? deps.createModelPort({ payer, request })
    : createStudyModelPort({
        billing: deps.billing,
        teamId: payer.billingOrganizationId,
        workspaceId: request.workspaceId,
        actorUserId: payer.userId,
        scopeId: request.scopeId,
      });
  const anchor = deps.createAnchorPort
    ? deps.createAnchorPort({ payer, request })
    : createStudyAnchorPort({
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
            idempotencyKey: `study:${request.artifactId}:v${request.versionNo}:anchor`,
            texts,
          }),
        onSemanticError: (error) =>
          logger.warn("Study evidence by-meaning anchoring failed", {
            err: error,
            artifactId: request.artifactId,
          }),
      });

  const budget = AbortSignal.timeout(STUDY_JOB_TIMEOUT_MS[corpusMode(corpus)]);
  const signal = deps.signal ? AbortSignal.any([deps.signal, budget]) : budget;

  const focus = request.options?.focus?.trim();
  const result = await generateStudyContent(
    {
      model,
      anchor,
      signal,
      ...(deps.checkpoint ? { checkpoint: deps.checkpoint } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    },
    {
      kind: request.kind,
      artifactId: request.artifactId,
      versionNo: request.versionNo,
      chunks: corpus.chunks,
      options,
      ...(focus ? { focus } : {}),
      recipe: {
        options: request.options ?? {},
        ...(focus ? { focus } : {}),
        sourceIds: request.sourceIds,
      },
      inputs: {
        selection: "sources",
        sources: corpus.sources.map(({ sourceId, documentId, contentHash }) => ({
          sourceId,
          documentId,
          contentHash,
        })),
      },
      modelAlias,
      rootLabel: rootLabelOf(corpus.sources),
      ...(request.previousIds ? { previousIds: request.previousIds } : {}),
    },
  );
  const durationMs = Date.now() - startedAt;
  // Counts and identifiers only: never source text or item content.
  logger.info("Study artifact generated", {
    artifactId: request.artifactId,
    versionNo: request.versionNo,
    kind: request.kind,
    mode: result.mode,
    groups: result.stats.groups,
    inputTokensEstimated: result.stats.tokensEstimated,
    requested: result.stats.requested,
    kept: result.stats.kept,
    dropped: result.stats.dropped,
    durationMs,
    payerUserId: payer.userId,
    modelAlias,
    promptVersion: result.content.generation.promptVersion,
  });
  return { ...result, payer, sources: corpus.sources, durationMs };
}
