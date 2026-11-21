import type {
  AgentToolWebProvider,
  AgentToolWebSearchResultItem,
} from "@sourceweft/contracts/agent-tools";
import {
  isGroundedGenerationError,
  type GroundedAnchorPort,
  type GroundedModelPort,
} from "@sourceweft/contracts/grounded-generation";
import type {
  ResearchCitation,
  ResearchErrorCode,
  ResearchLedgerEntry,
  ResearchPhase,
  ResearchProgress,
} from "@sourceweft/contracts/source-research";
import { addLedgerEntry, type LedgerEntry } from "./ledger";
import { RESEARCH_LIMITS } from "./limits";
import { verifyReport } from "./report-validation";
import {
  buildDigestPrompt,
  buildPlanPrompt,
  buildQueriesPrompt,
  buildReportPrompt,
  buildSelectPrompt,
  parseDigest,
  parsePlan,
  parseQueries,
  parseReport,
  parseSelection,
  RESEARCH_SCHEMAS,
} from "./prompts";

/** How many results each search query asks the provider for. */
const SEARCH_RESULTS_PER_QUERY = 6;
/** A round reads at most this many pages, each truncated before the digest call. */
const MAX_PAGES_PER_ROUND = 8;
const PAGE_TEXT_MAX_CHARS = 8_000;
/** The report call plus at most two rewrites when ids are fabricated. */
const REPORT_MAX_ATTEMPTS = 3;

export type ResearchRepo = {
  saveProgress(
    runId: string,
    patch: {
      phase?: ResearchPhase;
      progress?: ResearchProgress;
      plan?: string[];
      ledger?: ResearchLedgerEntry[];
      modelCalls?: number;
    },
  ): Promise<void>;
  isCancelRequested(runId: string): Promise<boolean>;
};

export type ResearchDeps = {
  web: AgentToolWebProvider;
  model: GroundedModelPort;
  anchor: GroundedAnchorPort;
  repo: ResearchRepo;
  now(): number;
  signal?: AbortSignal;
};

export type ResearchResume = {
  plan: string[] | null;
  ledger: LedgerEntry[];
  progress: ResearchProgress;
};

export type ResearchInput = {
  runId: string;
  topic: string;
  resume?: ResearchResume;
};

export type ResearchResult =
  | { status: "ready"; report: string; citations: ResearchCitation[] }
  | { status: "cancelled" }
  | { status: "failed"; errorCode: ResearchErrorCode };

type RoundOutcome = "enough" | "continue" | "web_failed";

/**
 * The deep-research loop: plan → each round (search queries → search → select →
 * fetch → digest into the ledger → decide if enough) → report → verify. Every
 * step checks for cancellation and the budget first; model-call billing is made
 * idempotent by a per-call key so a restart never charges twice. Page text used
 * to verify citations is kept only in memory and never written to the ledger or
 * to saved progress.
 */
export async function runResearch(
  input: ResearchInput,
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const { runId, topic } = input;
  const limits = RESEARCH_LIMITS;
  const startedAt = deps.now();
  const referenceId = `research:${runId}`;

  let plan: string[] | null = input.resume?.plan ?? null;
  let ledger: LedgerEntry[] = input.resume?.ledger ?? [];
  const progress: ResearchProgress = input.resume?.progress ?? {
    round: 0,
    searches: 0,
    pagesRead: 0,
    modelCalls: 0,
  };
  let phase: ResearchPhase = "planning";
  let gaps: string[] = [];
  // entryId -> full page text, in memory only, for citation verification.
  const pageTexts = new Map<string, string>();

  const cancelled = async () =>
    deps.signal?.aborted === true || (await deps.repo.isCancelRequested(runId));

  const persist = async () => {
    await deps.repo.saveProgress(runId, {
      phase,
      progress: { ...progress },
      ...(plan ? { plan } : {}),
      ledger,
      modelCalls: progress.modelCalls,
    });
  };

  const callModel = async (spec: {
    operation: string;
    system: string;
    user: string;
    schema: {
      name: string;
      description: string;
      schema: Record<string, unknown>;
    };
    maxTokens: number;
  }): Promise<unknown> => {
    const n = progress.modelCalls + 1;
    const output = await deps.model.completeStructured({
      operation: spec.operation,
      idempotencyKey: `research:${runId}:call:${n}`,
      referenceId,
      system: spec.system,
      user: spec.user,
      schema: spec.schema,
      maxTokens: spec.maxTokens,
    });
    progress.modelCalls = n;
    await persist();
    return output;
  };

  const budgetReached = () =>
    progress.round >= limits.maxRounds ||
    progress.searches >= limits.maxSearches ||
    progress.pagesRead >= limits.maxPages ||
    progress.modelCalls >= limits.maxModelCalls ||
    deps.now() - startedAt >= limits.maxMillis;

  const runRound = async (): Promise<RoundOutcome> => {
    phase = "searching";
    const queriesOut = await callModel({
      operation: "research.queries",
      ...buildQueriesPrompt({ topic, plan: plan ?? [], gaps }),
      schema: RESEARCH_SCHEMAS.queries,
      maxTokens: 300,
    });
    const queries = parseQueries(queriesOut);

    const hitsByUrl = new Map<string, AgentToolWebSearchResultItem>();
    for (const query of queries) {
      if (progress.searches >= limits.maxSearches) break;
      let result;
      try {
        result = await deps.web.search({
          query,
          limit: SEARCH_RESULTS_PER_QUERY,
        });
      } catch {
        // A search provider outage fails the run; we never switch data sources.
        return "web_failed";
      }
      progress.searches += 1;
      for (const item of result.results) {
        if (hitsByUrl.has(item.url)) continue;
        if (ledger.some((entry) => entry.url === item.url)) continue;
        hitsByUrl.set(item.url, item);
      }
    }
    await persist();

    const hits = [...hitsByUrl.values()];
    if (hits.length === 0) {
      progress.round += 1;
      await persist();
      return "continue";
    }

    phase = "reading";
    const selectOut = await callModel({
      operation: "research.select",
      ...buildSelectPrompt({
        topic,
        gaps,
        hits: hits.map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.snippet,
        })),
      }),
      schema: RESEARCH_SCHEMAS.selection,
      maxTokens: 300,
    });
    const pageBudget = Math.min(
      MAX_PAGES_PER_ROUND,
      limits.maxPages - progress.pagesRead,
    );
    const toRead = parseSelection(selectOut)
      .filter(
        (url) =>
          hitsByUrl.has(url) && !ledger.some((entry) => entry.url === url),
      )
      .slice(0, pageBudget);

    const fetched: { url: string; title: string; text: string }[] = [];
    for (const url of toRead) {
      let page;
      try {
        const result = await deps.web.fetch({ items: [{ url }] });
        page = result.results[0];
      } catch {
        // A single page that fails to fetch is skipped; the rest still count.
        continue;
      }
      if (!page || page.error || !page.markdown) continue;
      progress.pagesRead += 1;
      fetched.push({
        url,
        title: page.title ?? hitsByUrl.get(url)?.title ?? url,
        text: page.markdown,
      });
    }
    await persist();

    if (fetched.length === 0) {
      progress.round += 1;
      await persist();
      return "continue";
    }

    const digestOut = await callModel({
      operation: "research.digest",
      ...buildDigestPrompt({
        topic,
        plan: plan ?? [],
        pages: fetched.map((page) => ({
          url: page.url,
          title: page.title,
          text: page.text.slice(0, PAGE_TEXT_MAX_CHARS),
        })),
      }),
      schema: RESEARCH_SCHEMAS.digest,
      maxTokens: 1_500,
    });
    const digest = parseDigest(digestOut);

    for (const page of fetched) {
      if (ledger.length >= limits.maxPages) break;
      if (ledger.some((entry) => entry.url === page.url)) continue;
      const found = digest.pages.find(
        (candidate) => candidate.url === page.url,
      );
      if (!found || (found.points.length === 0 && found.quotes.length === 0)) {
        continue;
      }
      ledger = addLedgerEntry(
        ledger,
        {
          url: page.url,
          title: page.title,
          points: found.points,
          quotes: found.quotes,
        },
        { maxPages: limits.maxPages },
      );
      const added = ledger.find((entry) => entry.url === page.url);
      if (added) pageTexts.set(added.id, page.text);
    }
    gaps = digest.missing;
    progress.round += 1;
    await persist();

    return digest.enough ? "enough" : "continue";
  };

  // --- plan and rounds, with credit exhaustion diverting to the report --------
  let creditsExhausted = false;
  try {
    if (await cancelled()) return { status: "cancelled" };

    if (!plan) {
      phase = "planning";
      const planOut = await callModel({
        operation: "research.plan",
        ...buildPlanPrompt(topic),
        schema: RESEARCH_SCHEMAS.plan,
        maxTokens: 400,
      });
      plan = parsePlan(planOut);
      await persist();
    }

    while (!budgetReached()) {
      if (await cancelled()) return { status: "cancelled" };
      const outcome = await runRound();
      if (outcome === "web_failed") {
        return { status: "failed", errorCode: "WEB_PROVIDER_UNAVAILABLE" };
      }
      if (outcome === "enough") break;
    }
  } catch (error) {
    if (
      isGroundedGenerationError(error) &&
      error.code === "INSUFFICIENT_CREDITS"
    ) {
      if (ledger.length === 0) {
        return { status: "failed", errorCode: "INSUFFICIENT_CREDITS" };
      }
      // Evidence exists: try to write the report once with the credit still left.
      creditsExhausted = true;
    } else {
      // Other model failures propagate so the queue can retry the whole job.
      throw error;
    }
  }

  // --- report -----------------------------------------------------------------
  phase = "reporting";
  await persist();

  if (ledger.length === 0) {
    return { status: "failed", errorCode: "NO_RESULTS" };
  }
  if (deps.now() - startedAt >= limits.maxMillis) {
    return { status: "failed", errorCode: "TIME_LIMIT" };
  }

  // On resume the ledger holds pages whose text is no longer in memory; fetch
  // them once, just for verification, skipping any that fail.
  for (const entry of ledger) {
    if (pageTexts.has(entry.id)) continue;
    try {
      const result = await deps.web.fetch({ items: [{ url: entry.url }] });
      const page = result.results[0];
      if (page && !page.error && page.markdown) {
        pageTexts.set(entry.id, page.markdown);
      }
    } catch {
      // Skip a page that no longer fetches; its citations drop in verification.
    }
  }

  let unknownIds: string[] = [];
  for (let attempt = 0; attempt < REPORT_MAX_ATTEMPTS; attempt += 1) {
    if (await cancelled()) return { status: "cancelled" };

    let reportOut;
    try {
      reportOut = await callModel({
        operation: "research.report",
        ...buildReportPrompt({ topic, plan: plan ?? [], ledger, unknownIds }),
        schema: RESEARCH_SCHEMAS.report,
        maxTokens: 3_000,
      });
    } catch (error) {
      if (
        isGroundedGenerationError(error) &&
        error.code === "INSUFFICIENT_CREDITS"
      ) {
        return { status: "failed", errorCode: "INSUFFICIENT_CREDITS" };
      }
      throw error;
    }

    const draft = parseReport(reportOut);
    if (draft) {
      const verdict = await verifyReport({
        report: draft,
        ledger,
        pageTexts,
        anchor: deps.anchor,
      });
      if (verdict.ok) {
        return {
          status: "ready",
          report: verdict.report,
          citations: verdict.citations,
        };
      }
      unknownIds = verdict.unknownEntryIds;
    } else {
      unknownIds = [];
    }

    // With credits already exhausted there is no budget to rewrite.
    if (creditsExhausted) break;
  }

  return { status: "failed", errorCode: "RESEARCH_QUALITY_TOO_LOW" };
}
