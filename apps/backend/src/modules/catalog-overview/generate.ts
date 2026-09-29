import {
  CATALOG_OVERVIEW_LOCALES,
  type CatalogClassificationOutcome,
  type CatalogOverviewJson,
  type CatalogOverviewLocale,
} from "@sourceweft/db";
import { logger } from "../../shared/logger";
import { getSystemModelReadiness } from "../../shared/model-gateway/system-client";
import { overviewResultKey } from "./keys";
import { createOverviewModelCall } from "./model";
import type {
  OverviewGenerateResult,
  OverviewModelCall,
  OverviewPrompt,
  OverviewSubject,
  OverviewSubjectAdapter,
  ParsedOverview,
} from "./types";

export type GenerateOverviewInput<TPrompt extends OverviewPrompt> = {
  versionId: string;
  scopeId: string;
  // The system model under the adapter's purpose and output spec, unless
  // given (tests, or an evaluation under another purpose).
  callModel?: OverviewModelCall<TPrompt>;
  // Whether the system model can take the call; its readiness unless given.
  modelReady?: () => Promise<boolean>;
  // The reserved request this run belongs to. Without one, a request is
  // reserved here (forced when `force`).
  requestId?: string;
  force?: boolean;
  // The model the result is keyed under (overviewModelConfigurationKey).
  // Without one — a test-injected caller — nothing is reused from the cache.
  modelConfigurationKey?: string;
};

/**
 * Writes one version's overviews unless there is nothing to do: the version
 * is gone or not eligible, the request is stale or already done, the kind has
 * nothing to describe, or the system model is not ready. Identical input
 * already described elsewhere is copied instead of asking the model. Throws
 * on a model or output failure, for the job to retry.
 */
export async function generateOverview<
  TSubject extends OverviewSubject,
  TPrompt extends OverviewPrompt,
  TClassification extends CatalogClassificationOutcome,
  TSkip extends string,
>(
  adapter: OverviewSubjectAdapter<TSubject, TPrompt, TClassification, TSkip>,
  input: GenerateOverviewInput<TPrompt>,
): Promise<OverviewGenerateResult<TSkip>> {
  const { store } = adapter;
  const subject = await adapter.loadSubject(input.versionId);
  if (!subject) return { status: "skipped", reason: "missing-version" };
  if (!subject.eligible) return { status: "skipped", reason: "not-eligible" };
  // Claim before any work: a request that is stale (a newer one fences it)
  // or finished gets no model call.
  const state = input.requestId
    ? await store.claim(subject.versionId, input.requestId)
    : await store
        .request(subject.versionId, Boolean(input.force))
        .then((row) =>
          row ? store.claim(subject.versionId, row.requestId) : null,
        );
  if (!state) return { status: "skipped", reason: "already-generated" };
  const skip = adapter.skipReason(subject);
  if (skip) return { status: "skipped", reason: skip };
  const modelReady = input.modelReady
    ? await input.modelReady()
    : (await getSystemModelReadiness()).ready;
  if (!modelReady)
    return { status: "skipped", reason: "system-model-not-ready" };

  const prompt = adapter.buildPrompt(subject);
  const resultKey = overviewResultKey({
    fingerprint: subject.fingerprint,
    prompt,
    model: input.modelConfigurationKey ?? input.scopeId,
  });
  // A forced request always asks the model again.
  if (!state.force && !input.force && input.modelConfigurationKey) {
    const cached = await store.findCached(resultKey, subject.versionId);
    if (cached) {
      const published = await store.publish({
        ...cached,
        subject,
        requestId: state.requestId,
        resultKey,
        modelConfigurationKey: input.modelConfigurationKey,
      });
      return published
        ? { status: "copied", rows: CATALOG_OVERVIEW_LOCALES.length }
        : { status: "skipped", reason: "not-eligible" };
    }
  }
  const callModel =
    input.callModel ?? createOverviewModelCall<TPrompt>(adapter);
  const { output, model } = await callModel({
    prompt,
    versionId: subject.versionId,
    scopeId: input.scopeId,
  });
  let parsed: ParsedOverview<TClassification>;
  try {
    parsed = adapter.parseOutput(output, subject, prompt);
  } catch (error) {
    // Which subject's answer was refused and by which rule; the job's own
    // failure line names only the version. Nothing of the answer or the
    // prompt is logged. Rethrown as is: the job retries as before.
    logger.info(`${adapter.label} overview output rejected`, {
      kind: adapter.kind,
      ...adapter.logFields(subject, prompt),
      model,
      ...rejectionFields(error),
    });
    throw error;
  }
  const published = await store.publish({
    subject,
    requestId: state.requestId,
    resultKey,
    modelConfigurationKey: input.modelConfigurationKey,
    classification: parsed.classification,
    model,
    overviews: everyLocale(parsed.overviews),
  });
  if (!published) return { status: "skipped", reason: "not-eligible" };
  logger.info(`${adapter.label} overview generated`, {
    kind: adapter.kind,
    ...adapter.logFields(subject, prompt),
    model,
  });
  return { status: "generated", model };
}

/**
 * A refused answer's error for the log: its message, plus the rule it broke
 * when the kind's error names one (`code`, or the MCP parser's `reason`).
 */
function rejectionFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const { code, reason } = error as Error & {
    code?: unknown;
    reason?: unknown;
  };
  return {
    error: error.message,
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Exactly the catalog locales, all of them: one is never published alone. */
function everyLocale(
  overviews: Record<CatalogOverviewLocale, CatalogOverviewJson>,
): Record<CatalogOverviewLocale, CatalogOverviewJson> {
  const missing = CATALOG_OVERVIEW_LOCALES.filter(
    (locale) => !overviews[locale],
  );
  if (missing.length > 0)
    throw new Error(`Overview is missing locales: ${missing.join(", ")}`);
  return Object.fromEntries(
    CATALOG_OVERVIEW_LOCALES.map((locale) => [locale, overviews[locale]]),
  ) as Record<CatalogOverviewLocale, CatalogOverviewJson>;
}
