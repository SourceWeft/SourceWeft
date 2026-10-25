import { randomUUID } from "node:crypto";
import { logger } from "../../../shared/logger";
import {
  getSystemModelReadiness,
  SystemModelUnavailableError,
  withSystemModel,
} from "../../../shared/model-gateway/system-client";
import {
  findSummaryTranslationCandidates,
  writeSummaryTranslation,
  type SummaryTranslationCandidate,
} from "./summary-translation-repository";
import {
  MCP_SUMMARY_TRANSLATION_OUTPUT_DESCRIPTION,
  MCP_SUMMARY_TRANSLATION_OUTPUT_NAME,
  MCP_SUMMARY_TRANSLATION_OUTPUT_SCHEMA,
  buildSummaryTranslationPrompt,
  needsTranslation,
  parseSummaryTranslation,
  parseSummaryTranslationOutput,
  settledRecord,
  summarySourceHash,
  translatableSummary,
  translatedRecord,
  translationIsCurrent,
  translationIsDue,
  type McpSummaryTranslation,
} from "./summary-translation";
import { detectDescriptionLanguage } from "./description-language";

/**
 * One pass of the summary translation (Issue #367): for entries without an AI
 * overview, the short description in Simplified and Traditional Chinese.
 * Platform work on the system model, billed to no team; the scheduler runs a
 * pass on the AI overview's tick, so a large catalog is worked through a
 * small batch at a time.
 */

/** Model calls one pass may make: a fixed pace, not a setting. */
export const MCP_SUMMARY_TRANSLATION_PASS_LIMIT = 20;

/** Model errors in a row after which a pass gives up: the model is down. */
const MAX_CONSECUTIVE_MODEL_ERRORS = 3;

/** The model's answer for one summary: the structured output and the model. */
export type SummaryTranslationModelCall = (input: {
  system: string;
  user: string;
  subjectRef: string;
  scopeId: string;
}) => Promise<{ output: unknown; model: string }>;

export type SummaryTranslationDeps = {
  findCandidates: (input: {
    limit: number;
    now: Date;
  }) => Promise<SummaryTranslationCandidate[]>;
  write: (versionId: string, record: McpSummaryTranslation) => Promise<void>;
  callModel: SummaryTranslationModelCall;
  modelReady: () => Promise<boolean>;
  now: () => Date;
};

/** The system model under `mcp_market.translation`: no tools, thinking off. */
export const callSummaryTranslationModel: SummaryTranslationModelCall = async (
  input,
) => {
  const result = await withSystemModel(
    {
      purpose: "mcp_market.translation",
      subjectRef: input.subjectRef,
      scopeId: input.scopeId,
    },
    (chat) =>
      chat.complete({
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        structuredOutput: {
          name: MCP_SUMMARY_TRANSLATION_OUTPUT_NAME,
          description: MCP_SUMMARY_TRANSLATION_OUTPUT_DESCRIPTION,
          schema: MCP_SUMMARY_TRANSLATION_OUTPUT_SCHEMA,
        },
        thinking: { mode: "off", enabled: false, includeReasoning: false },
        maxTokens: 600,
        temperature: 0,
      }),
  );
  return {
    output: result.structuredOutput ?? result.raw?.content,
    model: result.providerModel ?? result.model,
  };
};

const defaultDeps: SummaryTranslationDeps = {
  findCandidates: findSummaryTranslationCandidates,
  write: writeSummaryTranslation,
  callModel: callSummaryTranslationModel,
  modelReady: async () => (await getSystemModelReadiness()).ready,
  now: () => new Date(),
};

export type SummaryTranslationOutcome =
  | "translated"
  | "reused"
  | "not-needed"
  | "failed";

export type SummaryTranslationReport = {
  identifier: string;
  outcome: SummaryTranslationOutcome;
  summary: string;
  record: McpSummaryTranslation;
};

export type SummaryTranslationPassResult = {
  /** The system model was not ready: nothing was looked at. */
  skipped: boolean;
  dryRun: boolean;
  reports: SummaryTranslationReport[];
};

/**
 * Translate the next candidates. With `dryRun` the model is called but
 * nothing is stored, and the reports carry the Chinese texts for review.
 * A previous version's current record is reused without a model call.
 * One entry's failure (a refused or invalid answer, a model error) gives it a
 * `failed` record, retried after a day, and the pass goes on. A system model
 * that is not ready, or errors several times in a row, ends the pass early:
 * every remaining call would fail the same way.
 */
export async function runSummaryTranslationPass(
  options: { limit?: number; dryRun?: boolean } = {},
  deps: SummaryTranslationDeps = defaultDeps,
): Promise<SummaryTranslationPassResult> {
  const dryRun = options.dryRun === true;
  const result: SummaryTranslationPassResult = {
    skipped: false,
    dryRun,
    reports: [],
  };
  if (!(await deps.modelReady())) {
    result.skipped = true;
    return result;
  }
  const now = deps.now();
  const candidates = await deps.findCandidates({
    limit: options.limit ?? MCP_SUMMARY_TRANSLATION_PASS_LIMIT,
    now,
  });
  const scopeId = `mcp-summary-translation:${randomUUID()}`;
  let modelErrors = 0;

  for (const candidate of candidates) {
    const stored = parseSummaryTranslation(candidate.record);
    const text = translatableSummary(candidate.summary);
    if (!text || !translationIsDue(stored, candidate.summary, now)) continue;

    const report = async (
      outcome: SummaryTranslationOutcome,
      record: McpSummaryTranslation,
    ) => {
      if (!dryRun) await deps.write(candidate.versionId, record);
      result.reports.push({
        identifier: candidate.identifier,
        outcome,
        summary: candidate.summary,
        record,
      });
    };

    // A Chinese description needs no translation into Chinese.
    if (!needsTranslation(detectDescriptionLanguage(text))) {
      await report(
        "not-needed",
        settledRecord({ summary: candidate.summary, status: "not-needed", now }),
      );
      continue;
    }
    // An earlier version of the server was translated from the same text.
    const previous = parseSummaryTranslation(candidate.previous);
    if (
      translationIsCurrent(previous, candidate.summary) &&
      previous.status !== "failed"
    ) {
      await report("reused", { ...previous });
      continue;
    }

    const prompt = buildSummaryTranslationPrompt(text);
    try {
      const answer = await deps.callModel({
        ...prompt,
        subjectRef: `mcp-server-version:${candidate.versionId}`,
        scopeId,
      });
      modelErrors = 0;
      const zhCN = parseSummaryTranslationOutput(answer.output);
      if (!zhCN) {
        logger.info("MCP summary translation rejected", {
          identifier: candidate.identifier,
          sourceHash: summarySourceHash(candidate.summary),
        });
        await report(
          "failed",
          settledRecord({ summary: candidate.summary, status: "failed", now }),
        );
        continue;
      }
      await report(
        "translated",
        translatedRecord({
          summary: candidate.summary,
          zhCN,
          model: answer.model,
          now,
        }),
      );
    } catch (error) {
      logger.warn("MCP summary translation call failed", {
        identifier: candidate.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
      modelErrors += 1;
      if (
        error instanceof SystemModelUnavailableError ||
        modelErrors >= MAX_CONSECUTIVE_MODEL_ERRORS
      ) {
        break;
      }
      await report(
        "failed",
        settledRecord({ summary: candidate.summary, status: "failed", now }),
      );
    }
  }
  return result;
}
