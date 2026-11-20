/**
 * Data table evaluation (#591, plan Task 9): the baseline and the entry gate.
 *
 * Generation — fills each evaluation set's table with the real default chat
 * model, the way a queued table job does, and records every run:
 *
 *   pnpm --filter @sourceweft/backend exec tsx -r dotenv/config scripts/eval-table.ts \
 *     --set <dir> [--set <dir> ...] --runs 3 --out <dir>
 *
 *   Writes `<out>/<setId>/run-<n>.json`. Never reads `reference.json`.
 *
 *   `--chat-target deepinfra --structured-output as-production|strict` sends
 *   the fill/merge calls (and the anchoring embeddings) to the production
 *   DeepInfra route instead of the deployment's chat-default, built from code
 *   constants and DEEPINFRA_API_KEY without reading the database
 *   (`modules/tables/eval/deepinfra-target.ts`). `as-production` keeps
 *   production's provider `supports` (no `json_schema_strict`); `strict` adds
 *   it. Cost is the provider's reported `estimated_cost`, else unknown.
 *
 * Scoring — compares runs with the human-labelled reference (no model call):
 *
 *   ... scripts/eval-table.ts --score --results <dir> [--judgments <file>] \
 *     [--set <dir> ...] --out <report.md>
 *
 *   Also writes `<report>.cells.csv` beside the report. The reference is read
 *   from the set directory recorded in each run (or a `--set` with that id).
 *   Judgments: `{ "<set>/<run>/<source>/<column>": "match" | "mismatch" }`.
 *
 * Size — the worst-case table against the 1 MiB payload limit (no model call):
 *
 *   ... scripts/eval-table.ts --size --out <report.md> [--db]
 *
 *   `--db` adds a jsonb round trip (temporary table, one transaction) against
 *   DATABASE_URL; without it no database is touched.
 *
 * A set directory holds `set.json`, `sources/*.md` and `reference.json`; see
 * `parseEvalSet` for the format.
 *
 * What generation shares with production, and where it differs:
 * - Sources are parsed and chunked by the text parser production uses for a
 *   text or markdown upload (`modules/sources/parsers/text.ts`, which calls
 *   `chunkSourceContent` of `@sourceweft/builtin-document-parsers`) with the
 *   deployment's default parsing config. Chunks carry `headingPath: null` and
 *   `language: null`, as the ingestion writer stores them.
 * - The engine is reached through the capability registry
 *   (`loadTableGeneration`), with the production figure port, the production
 *   anchor port (`createGroundedAnchorPort`, by-meaning pass on the default
 *   embedding profile) and the job's time budget; the engine's own prompt
 *   version, concurrency, output budgets and quality gate apply unchanged.
 * - The model port makes the call `completeStructuredWithDefaultChat` makes
 *   (default chat profile, system + user turn, structured output, thinking off
 *   with the profile's thinking support filled in, temperature 0.2), but on a
 *   gateway client built without the observability sink and outside any
 *   billing scope: nothing is charged and nothing is written to the database.
 *   Cost comes from the call's reported cost or the profile's price book
 *   (`computeProviderCost`, read only).
 * - One attempt per run: the queue's job retry is not repeated.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  TABLE_LIMITS,
  tableColumnInputSchema,
  tableColumnTypeSchema,
  type TableContent,
} from "@sourceweft/contracts/table";
import {
  cellsToCsv,
  formatScoreReport,
  scoreRuns,
  type EvalRunScoreInput,
  type EvalSetScoreInput,
  type GotCell,
  type Judgments,
} from "../src/modules/tables/eval/scoring";
import { buildWorstCaseTable, measureTableSize } from "../src/modules/tables/eval/worst-case";

const RUN_FORMAT = "sourceweft.table-eval.run/1";

/* --------------------------------------------------------------- set files */

const setSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9._-]+$/, "a set id is used as a directory name"),
    title: z.string(),
    language: z.string().min(2).max(35),
    instruction: z.string().max(TABLE_LIMITS.instructionChars).optional(),
    columns: z
      .array(
        z.object({
          id: z.string().min(1),
          name: tableColumnInputSchema.shape.name,
          description: tableColumnInputSchema.shape.description,
          type: tableColumnTypeSchema,
        }),
      )
      .min(1)
      .max(TABLE_LIMITS.maxColumns),
    sources: z
      .array(z.object({ id: z.string().min(1), title: z.string(), file: z.string().min(1) }))
      .min(1)
      .max(TABLE_LIMITS.maxSources),
  })
  .superRefine((set, ctx) => {
    const unique = (values: string[], what: string) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", message: `duplicate ${what} id` });
      }
    };
    unique(set.columns.map((column) => column.id), "column");
    unique(set.sources.map((source) => source.id), "source");
    if (set.columns.length * set.sources.length > TABLE_LIMITS.maxCells) {
      ctx.addIssue({ code: "custom", message: `more than ${TABLE_LIMITS.maxCells} cells` });
    }
  });
type EvalSet = z.infer<typeof setSchema>;

const referenceSchema = z.object({
  cells: z.record(
    z.string(),
    z.record(
      z.string(),
      z
        .object({
          status: z.enum(["found", "not_found"]),
          value: z.string().optional(),
          quote: z.string().optional(),
        })
        .refine((cell) => cell.status !== "found" || !!cell.value?.trim(), {
          message: "a found reference cell needs a value",
        }),
    ),
  ),
});

/** Reads and checks `<dir>/set.json`. */
async function parseEvalSet(dir: string): Promise<EvalSet> {
  const raw = JSON.parse(await readFile(join(dir, "set.json"), "utf8")) as unknown;
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${join(dir, "set.json")}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function insideDir(dir: string, file: string) {
  const path = resolve(dir, file);
  if (!path.startsWith(resolve(dir) + sep)) {
    throw new Error(`${file} is outside the set directory ${dir}`);
  }
  return path;
}

/* --------------------------------------------------------------- run files */

type CallRecord = {
  operation: string;
  idempotencyKey: string;
  ms: number;
  ok: boolean;
  error?: string;
  provider?: string;
  providerModel?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  /** How the gateway obtained the structured answer (strict json_schema, tool, …). */
  structuredOutputMechanism?: string;
  structuredOutputFallback?: string;
  /** The cost the provider reported inline (DeepInfra `usage.estimated_cost`, OpenRouter `cost`). */
  reportedCostUsd: number | null;
  reportedCost?: { source: string; status: string; inlineUsd?: number; effectiveUsd?: number };
  /** The profile's price book; null when not looked up or not priced. */
  priceBookCostUsd: number | null;
  /** Reported cost when there is one, else the price book, else unknown. */
  costUsd: number | null;
  costSource: string | null;
};

type EmbeddingRecord = {
  ms: number;
  texts: number;
  ok: boolean;
  error?: string;
  provider?: string;
  providerModel?: string;
  inputTokens?: number;
  costUsd: number | null;
  costSource: string | null;
};

type RunCell = {
  status: GotCell["status"];
  value?: string;
  normalized?: number | string | boolean;
  evidence?: { chunkId: string; chunkNo?: number; quote: string }[];
};

type RunFile = {
  format: typeof RUN_FORMAT;
  set: {
    id: string;
    title: string;
    dir: string;
    language: string;
    instruction?: string;
    columns: { id: string; name: string; type: EvalSet["columns"][number]["type"]; engineId: string }[];
    sourceIds: string[];
  };
  run: number;
  startedAt: string;
  wallMs: number;
  model: TransportDescription;
  chunker: { parser: string; chunkSize: number; parserVersion: string };
  sources: { sourceId: string; title: string; file: string; chars: number; chunks: number; tokensEstimated: number }[];
  plan: { calls: number; cellsToFill: number; totalTokens: number; exceedsLimit: boolean };
  status: "ok" | "failed";
  error?: { code: string; name: string; message: string };
  stats?: TableContent["generation"]["stats"];
  promptVersion?: string;
  rowStatus: Record<string, "ok" | "failed" | "skipped">;
  /** By source id, then the set's column id. */
  cells: Record<string, Record<string, RunCell>>;
  calls: CallRecord[];
  embeddings: EmbeddingRecord[];
  semanticAnchorErrors: string[];
  totals: {
    calls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    /** Null when the cost of at least one call is unknown. */
    costUsd: number | null;
    embeddingCalls: number;
    embeddingTexts: number;
    embeddingInputTokens: number;
    embeddingCostUsd: number | null;
  };
  content?: TableContent;
};

const sumKnown = (values: (number | null)[]) =>
  values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);

/* -------------------------------------------------------------- transports */

type ChatRequest = import("@sourceweft/model-gateway").ChatCompleteInput;
type ChatResult = import("@sourceweft/model-gateway").ChatCompleteResult;
type EmbedResult = import("@sourceweft/model-gateway").EmbedBatchResult;
type ThinkingConfig = import("@sourceweft/model-gateway").ThinkingConfig;

type TransportDescription = {
  /** `default-profile`: the deployment's chat-default; `deepinfra`: the production DeepInfra route. */
  chatTarget: "default-profile" | "deepinfra";
  structuredOutput: "as-configured" | "as-production" | "strict";
  profileAlias: string;
  modelAlias: string;
  gatewayConfigId: string | null;
  configVersionId: string;
  routeTargets: { provider: string; model: string; priority?: number; ready: boolean }[];
  thinking: ThinkingConfig | undefined;
  embeddingProfileAlias: string;
  embeddingTargets: { provider: string; model: string }[];
  /** What this run read from the database to set up its transport. */
  databaseReads: string[];
};

type CallCost = Pick<
  CallRecord,
  "reportedCostUsd" | "reportedCost" | "priceBookCostUsd" | "costUsd" | "costSource"
>;

/** How the evaluation reaches the chat and embedding models; never billed, never recorded. */
type Transport = {
  description: TransportDescription;
  complete(input: ChatRequest, traceId: string): Promise<ChatResult>;
  embed(texts: string[], traceId: string): Promise<EmbedResult>;
  chatCost(result: ChatResult): Promise<CallCost>;
  embeddingCost(result: EmbedResult): Promise<{ costUsd: number | null; costSource: string | null }>;
};

function reportedCostOf(cost: import("@sourceweft/model-gateway").ModelCallCost | undefined) {
  const effective = cost?.effectiveUsd;
  return {
    reportedCostUsd: typeof effective === "number" && Number.isFinite(effective) ? effective : null,
    ...(cost
      ? {
          reportedCost: {
            source: cost.source,
            status: cost.status,
            ...(cost.inlineUsd === undefined ? {} : { inlineUsd: cost.inlineUsd }),
            ...(cost.effectiveUsd === undefined ? {} : { effectiveUsd: cost.effectiveUsd }),
          },
        }
      : {}),
  };
}

/**
 * The deployment's default chat profile (and default embedding profile), read
 * from the database the way production reads them, on a gateway client built
 * from the same routed configuration without the observability sink.
 */
async function openDefaultProfileTransport(): Promise<Transport> {
  const [
    { createModelGateway },
    { requireDefaultModelGatewayProfile },
    { buildRoutedModelGatewayConfig, loadRoutedGatewayConfig, assertGatewayConfigAvailable },
    { prepareEmbeddingProfile, validateEmbeddingResult },
    { resolveChatThinkingWithDefaults },
    { computeProviderCost },
    { TableGenerationError },
  ] = await Promise.all([
    import("@sourceweft/model-gateway"),
    import("../src/shared/model-gateway/client"),
    import("../src/shared/model-gateway/runtime"),
    import("../src/shared/model-gateway/embedding-identity"),
    import("../src/shared/model-gateway/thinking-defaults"),
    import("../src/modules/content/provider-cost"),
    import("@sourceweft/contracts/table-capability"),
  ]);

  // The default chat model or nothing, as `describeDefaultChatModel` decides.
  let chatProfile: Awaited<ReturnType<typeof requireDefaultModelGatewayProfile>>;
  try {
    chatProfile = await requireDefaultModelGatewayProfile("chat");
  } catch (error) {
    throw new TableGenerationError("MODEL_UNAVAILABLE", "The default chat model is not available", {}, { cause: error });
  }
  const routed = await loadRoutedGatewayConfig();
  if (!routed) throw new Error("Global model gateway configuration is not synchronized");
  assertGatewayConfigAvailable(routed, chatProfile.gatewayConfigId);
  const embedding = await prepareEmbeddingProfile();

  const chatGateway = createModelGateway(buildRoutedModelGatewayConfig(routed, { observeSink: null }));
  const embeddingGateway = createModelGateway(
    buildRoutedModelGatewayConfig(embedding.routedConfig, { observeSink: null }),
  );

  // `enrichChatThinking` in billed-client.ts: thinking off, plus the
  // profile's synced thinking-support facts; a failed lookup keeps it as is.
  const thinkingOff = { mode: "off", enabled: false, includeReasoning: false } as const;
  let thinking: ThinkingConfig | undefined = thinkingOff;
  try {
    thinking = await resolveChatThinkingWithDefaults({
      thinking: thinkingOff,
      profileAlias: chatProfile.profileAlias,
      modelAlias: chatProfile.modelAlias,
      gatewayConfigId: chatProfile.gatewayConfigId,
    });
  } catch (error) {
    console.warn("thinking-support lookup failed; thinking stays off as given", error);
  }

  const priceBook = async (
    kind: "chat" | "embedding",
    profileAlias: string,
    gatewayConfigId: string,
    result: ChatResult | EmbedResult,
  ) => {
    try {
      // No reported cost passed: this is the price book alone.
      const cost = await computeProviderCost({ gatewayConfigId, modelKind: kind, profileAlias, usage: result.usage });
      return { costUsd: cost.providerCostUsd, costSource: cost.costSource as string };
    } catch (error) {
      console.warn("price-book lookup failed", error);
      return { costUsd: null, costSource: "lookup_failed" };
    }
  };

  return {
    description: {
      chatTarget: "default-profile",
      structuredOutput: "as-configured",
      profileAlias: chatProfile.profileAlias,
      modelAlias: chatProfile.modelAlias,
      gatewayConfigId: chatProfile.gatewayConfigId,
      configVersionId: routed.versionId,
      routeTargets: (routed.modelRoutes[chatProfile.modelAlias]?.targets ?? []).map((target) => ({
        provider: target.provider,
        model: target.model,
        ...(target.priority === undefined ? {} : { priority: target.priority }),
        ready: routed.providers[target.provider]?.globalReady ?? false,
      })),
      thinking,
      embeddingProfileAlias: embedding.profile.profileAlias,
      embeddingTargets: (embedding.routedConfig.modelRoutes[embedding.profile.modelAlias]?.targets ?? []).map(
        ({ provider, model }) => ({ provider, model }),
      ),
      databaseReads: [
        "default chat profile",
        "active routed gateway configuration",
        "default embedding profile",
        "chat profile thinking support",
        "price book (per call)",
      ],
    },
    complete: (input, traceId) => chatGateway.chat.complete(input, { traceId }),
    async embed(texts, traceId) {
      const profile = embedding.profile;
      const result = await embeddingGateway.embeddings.embedBatch(
        {
          model: profile.profileAlias,
          profileAlias: profile.profileAlias,
          texts,
          dimensions: profile.requestedDimensions ?? undefined,
          executionMode: "GLOBAL",
        },
        { traceId },
      );
      validateEmbeddingResult(embedding.identity, result, result.embeddings);
      return result;
    },
    async chatCost(result) {
      const reported = reportedCostOf(result.observation?.cost);
      const book = await priceBook("chat", chatProfile.profileAlias, chatProfile.gatewayConfigId, result);
      return {
        ...reported,
        priceBookCostUsd: book.costUsd,
        costUsd: reported.reportedCostUsd ?? book.costUsd,
        costSource: reported.reportedCostUsd !== null ? "provider_reported" : book.costSource,
      };
    },
    async embeddingCost(result) {
      const reported = reportedCostOf(result.observation?.cost).reportedCostUsd;
      if (reported !== null) return { costUsd: reported, costSource: "provider_reported" };
      return priceBook("embedding", embedding.profile.profileAlias, embedding.profile.gatewayConfigId, result);
    },
  };
}

/**
 * The production DeepInfra route (`buildDeepInfraEvalTarget`), built from
 * code constants and DEEPINFRA_API_KEY alone: no database read. Fails before
 * any model call if it cannot be built, and fails a call that any other target
 * answered; it never falls back to the default profile.
 */
async function openDeepInfraTransport(structuredOutput: "as-production" | "strict"): Promise<Transport> {
  const [
    { createModelGateway },
    { buildRoutedModelGatewayConfig },
    { validateEmbeddingResult },
    { buildDeepInfraEvalTarget },
    { TableGenerationError },
  ] = await Promise.all([
    import("@sourceweft/model-gateway"),
    import("../src/shared/model-gateway/runtime"),
    import("../src/shared/model-gateway/embedding-identity"),
    import("../src/modules/tables/eval/deepinfra-target"),
    import("@sourceweft/contracts/table-capability"),
  ]);
  const target = buildDeepInfraEvalTarget({ apiKey: process.env.DEEPINFRA_API_KEY, structuredOutput });
  let gateway: ReturnType<typeof createModelGateway>;
  try {
    gateway = createModelGateway(buildRoutedModelGatewayConfig(target.routed, { observeSink: null }));
  } catch (error) {
    throw new Error("--chat-target deepinfra: the DeepInfra gateway client could not be built", { cause: error });
  }
  const expect = (
    what: string,
    result: { provider?: string; providerModel?: string },
    providerModel: string,
  ) => {
    if (result.provider !== "deepinfra" || result.providerModel !== providerModel) {
      // A typed error ends the whole fill instead of failing one row.
      throw new TableGenerationError(
        "MODEL_UNAVAILABLE",
        `--chat-target deepinfra: the ${what} call was answered by ${result.provider ?? "?"}/${result.providerModel ?? "?"}, not deepinfra/${providerModel}`,
      );
    }
  };

  return {
    description: {
      chatTarget: "deepinfra",
      structuredOutput,
      profileAlias: target.chat.profileAlias,
      modelAlias: target.chat.modelAlias,
      gatewayConfigId: null,
      configVersionId: target.routed.versionId,
      routeTargets: target.routed.modelRoutes[target.chat.modelAlias]!.targets.map((t) => ({
        provider: t.provider,
        model: t.model,
        ...(t.priority === undefined ? {} : { priority: t.priority }),
        ready: true,
      })),
      thinking: target.chat.thinking,
      embeddingProfileAlias: target.embedding.profileAlias,
      embeddingTargets: target.routed.modelRoutes[target.embedding.profileAlias]!.targets.map(
        ({ provider, model }) => ({ provider, model }),
      ),
      databaseReads: [],
    },
    async complete(input, traceId) {
      const result = await gateway.chat.complete(input, { traceId });
      expect("chat", result, target.chat.providerModel);
      return result;
    },
    async embed(texts, traceId) {
      const result = await gateway.embeddings.embedBatch(
        {
          model: target.embedding.profileAlias,
          profileAlias: target.embedding.profileAlias,
          texts,
          dimensions: target.embedding.requestedDimensions,
          executionMode: "GLOBAL",
        },
        { traceId },
      );
      expect("embedding", result, target.embedding.providerModel);
      validateEmbeddingResult(target.embedding.identity, result, result.embeddings);
      return result;
    },
    // No price book without the database: the reported cost or unknown.
    async chatCost(result) {
      const reported = reportedCostOf(result.observation?.cost);
      return {
        ...reported,
        priceBookCostUsd: null,
        costUsd: reported.reportedCostUsd,
        costSource: reported.reportedCostUsd !== null ? "provider_reported" : null,
      };
    },
    async embeddingCost(result) {
      const reported = reportedCostOf(result.observation?.cost).reportedCostUsd;
      return { costUsd: reported, costSource: reported !== null ? "provider_reported" : null };
    },
  };
}

/* -------------------------------------------------------------- generation */

async function generate(options: {
  setDirs: string[];
  runs: number;
  out: string;
  chatTarget: { kind: "default-profile" } | { kind: "deepinfra"; structuredOutput: "as-production" | "strict" };
}) {
  // Production modules are loaded only here: they read the environment, which
  // the scoring and size modes never need.
  const [
    { loadTableGeneration },
    { resolveTableLanguage },
    { createGroundedAnchorPort },
    { figuresCovered },
    { textSourceParser },
    { defaultParsingConfig },
    { isTableGenerationError },
    { estimateTokens },
  ] = await Promise.all([
    import("../src/modules/tables/capability"),
    import("../src/modules/tables/service"),
    import("../src/modules/grounded-generation/anchor-port"),
    import("../src/modules/citations/figures"),
    import("../src/modules/sources/parsers/text"),
    import("../src/modules/sources/parsing-config"),
    import("@sourceweft/contracts/table-capability"),
    import("@sourceweft/grounded-generation"),
  ]);

  const transport =
    options.chatTarget.kind === "deepinfra"
      ? await openDeepInfraTransport(options.chatTarget.structuredOutput)
      : await openDefaultProfileTransport();
  const described = transport.description;
  console.log(
    `chat target ${described.chatTarget} (${described.profileAlias}): ${
      described.routeTargets.map((t) => `${t.provider}/${t.model}${t.ready ? "" : " (not ready)"}`).join(", ") || "none"
    }; structured output ${described.structuredOutput}; embedding ${
      described.embeddingTargets.map((t) => `${t.provider}/${t.model}`).join(", ") || "none"
    }; database reads: ${described.databaseReads.join(", ") || "none"}`,
  );

  const parsingConfig = defaultParsingConfig();
  const generation = await loadTableGeneration();

  // Load every set and refuse to overwrite earlier results before spending anything.
  const loaded = [];
  for (const dir of options.setDirs) {
    const set = await parseEvalSet(dir);
    for (let run = 1; run <= options.runs; run += 1) {
      const file = join(options.out, set.id, `run-${run}.json`);
      if (existsSync(file)) throw new Error(`${file} exists; choose another --out`);
    }
    const sources = [];
    for (const source of set.sources) {
      const path = insideDir(dir, source.file);
      const bytes = await readFile(path);
      const extension = extname(path).toLowerCase();
      const mimeType = extension === ".md" || extension === ".markdown" ? "text/markdown" : "text/plain";
      const parsed = await textSourceParser.parse({
        fileName: basename(path),
        mimeType,
        fileSize: bytes.length,
        content: bytes,
        config: parsingConfig,
      });
      const documentId = `doc-${source.id}`;
      const chunks = parsed.chunks
        .map((chunk, index) => ({
          chunkId: `chunk-${source.id}-${index}`,
          sourceId: source.id,
          documentId,
          chunkNo: index,
          headingPath: null,
          language: null,
          text: chunk.text,
        }))
        // The corpus loader drops empty chunks.
        .filter((chunk) => chunk.text.trim().length > 0);
      sources.push({
        input: {
          sourceId: source.id,
          documentId,
          title: source.title,
          contentHash: createHash("sha256").update(parsed.content).digest("hex"),
          indexed: true,
          chunks,
        },
        meta: {
          sourceId: source.id,
          title: source.title,
          file: source.file,
          chars: parsed.content.length,
          chunks: chunks.length,
          tokensEstimated: chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0),
        },
      });
    }
    loaded.push({ dir: resolve(dir), set, sources });
  }

  for (const { dir, set, sources } of loaded) {
    const columns = generation.resolveColumns(
      set.columns.map(({ name, description, type }) => ({
        name,
        ...(description ? { description } : {}),
        type,
      })),
    );
    const engineIdOf = new Map(set.columns.map((column, index) => [column.id, columns[index]!.id]));
    const sourceInputs = sources.map((source) => source.input);
    const language = resolveTableLanguage({
      requested: set.language,
      sources: sourceInputs,
      uiLocale: set.language,
    });
    const plan = generation.planFill({ columns, sources: sourceInputs, language });
    const instruction = set.instruction?.trim();
    await mkdir(join(options.out, set.id), { recursive: true });

    for (let run = 1; run <= options.runs; run += 1) {
      const artifactId = `eval-${set.id}-run${run}`;
      const traceId = `eval-table:${set.id}:run-${run}`;
      const calls: CallRecord[] = [];
      const embeddings: EmbeddingRecord[] = [];
      const semanticAnchorErrors: string[] = [];

      const model = {
        async completeStructured(call: {
          operation: string;
          idempotencyKey: string;
          referenceId: string;
          system: string;
          user: string;
          schema: { name: string; description: string; schema: Record<string, unknown> };
          maxTokens: number;
        }) {
          const started = Date.now();
          try {
            const completion = await transport.complete(
              {
                model: described.modelAlias,
                profileAlias: described.profileAlias,
                messages: [
                  { role: "system", content: call.system },
                  { role: "user", content: call.user },
                ],
                structuredOutput: call.schema,
                ...(described.thinking ? { thinking: described.thinking } : {}),
                maxTokens: call.maxTokens,
                temperature: 0.2,
              },
              traceId,
            );
            calls.push({
              operation: call.operation,
              idempotencyKey: call.idempotencyKey,
              ms: Date.now() - started,
              ok: true,
              ...(completion.provider ? { provider: completion.provider } : {}),
              ...(completion.providerModel ? { providerModel: completion.providerModel } : {}),
              ...(completion.finishReason ? { finishReason: completion.finishReason } : {}),
              ...(completion.usage?.inputTokens === undefined ? {} : { inputTokens: completion.usage.inputTokens }),
              ...(completion.usage?.outputTokens === undefined ? {} : { outputTokens: completion.usage.outputTokens }),
              ...(completion.usage?.reasoningTokens === undefined ? {} : { reasoningTokens: completion.usage.reasoningTokens }),
              ...(completion.usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: completion.usage.cacheReadTokens }),
              ...(completion.structuredOutputDiagnostics
                ? {
                    structuredOutputMechanism: completion.structuredOutputDiagnostics.mechanism,
                    ...(completion.structuredOutputDiagnostics.fallbackReason
                      ? { structuredOutputFallback: completion.structuredOutputDiagnostics.fallbackReason }
                      : {}),
                  }
                : {}),
              ...(await transport.chatCost(completion)),
            });
            return completion.structuredOutput;
          } catch (error) {
            calls.push({
              operation: call.operation,
              idempotencyKey: call.idempotencyKey,
              ms: Date.now() - started,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              reportedCostUsd: null,
              priceBookCostUsd: null,
              costUsd: null,
              costSource: null,
            });
            throw error;
          }
        },
      };

      const anchor = createGroundedAnchorPort({
        embedTexts: async (texts) => {
          const started = Date.now();
          try {
            const result = await transport.embed(texts, traceId);
            const cost = await transport.embeddingCost(result);
            embeddings.push({
              ms: Date.now() - started,
              texts: texts.length,
              ok: true,
              ...(result.provider ? { provider: result.provider } : {}),
              ...(result.providerModel ? { providerModel: result.providerModel } : {}),
              ...(result.usage?.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
              costUsd: cost.costUsd,
              costSource: cost.costSource,
            });
            return result.embeddings;
          } catch (error) {
            embeddings.push({
              ms: Date.now() - started,
              texts: texts.length,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              costUsd: null,
              costSource: null,
            });
            throw error;
          }
        },
        onSemanticError: (error) =>
          semanticAnchorErrors.push(error instanceof Error ? error.message : String(error)),
      });

      const startedAt = new Date();
      let content: TableContent | undefined;
      let failure: RunFile["error"];
      try {
        const result = await generation.fillTable(
          {
            model,
            anchor,
            figures: { covered: figuresCovered },
            signal: AbortSignal.timeout(generation.limits.jobTimeoutMs),
          },
          {
            artifactId,
            versionNo: 1,
            columns,
            sources: sourceInputs,
            language,
            ...(instruction ? { instruction } : {}),
            modelAlias: described.modelAlias,
            recipe: {
              ...(instruction ? { instruction } : {}),
              columns: columns.map(({ id, name, description, type }) => ({
                id,
                name,
                ...(description ? { description } : {}),
                type,
              })),
              sourceIds: sourceInputs.map((source) => source.sourceId),
            },
          },
        );
        content = result.content;
      } catch (error) {
        // A failed run is a result: the gate counts it.
        failure = {
          code: isTableGenerationError(error) ? error.code : "ERROR",
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const wallMs = Date.now() - startedAt.getTime();

      const rowStatus: RunFile["rowStatus"] = {};
      const cells: RunFile["cells"] = {};
      for (const row of content?.rows ?? []) {
        rowStatus[row.sourceId] = row.status;
        const byColumn: Record<string, RunCell> = {};
        for (const column of set.columns) {
          const cell = row.cells[engineIdOf.get(column.id)!];
          if (!cell) continue;
          byColumn[column.id] =
            cell.status === "found"
              ? {
                  status: "found",
                  value: cell.value,
                  ...(cell.normalized === undefined ? {} : { normalized: cell.normalized }),
                  evidence: cell.evidence.map((evidence) => ({
                    chunkId: evidence.chunkId,
                    ...(evidence.chunkNo === undefined ? {} : { chunkNo: evidence.chunkNo }),
                    quote: evidence.quote,
                  })),
                }
              : { status: cell.status };
        }
        cells[row.sourceId] = byColumn;
      }

      const record: RunFile = {
        format: RUN_FORMAT,
        set: {
          id: set.id,
          title: set.title,
          dir,
          language,
          ...(instruction ? { instruction } : {}),
          columns: set.columns.map((column) => ({
            id: column.id,
            name: column.name,
            type: column.type,
            engineId: engineIdOf.get(column.id)!,
          })),
          sourceIds: set.sources.map((source) => source.id),
        },
        run,
        startedAt: startedAt.toISOString(),
        wallMs,
        model: described,
        chunker: {
          parser: "modules/sources/parsers/text.ts → @sourceweft/builtin-document-parsers chunkSourceContent",
          chunkSize: parsingConfig.chunkSize,
          parserVersion: parsingConfig.parserVersion,
        },
        sources: sources.map((source) => source.meta),
        plan: {
          calls: plan.calls,
          cellsToFill: plan.cellsToFill,
          totalTokens: plan.totalTokens,
          exceedsLimit: plan.exceedsLimit,
        },
        status: failure ? "failed" : "ok",
        ...(failure ? { error: failure } : {}),
        ...(content ? { stats: content.generation.stats, promptVersion: content.generation.promptVersion } : {}),
        rowStatus,
        cells,
        calls,
        embeddings,
        semanticAnchorErrors,
        totals: {
          calls: calls.length,
          failedCalls: calls.filter((call) => !call.ok).length,
          inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
          outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
          reasoningTokens: calls.reduce((sum, call) => sum + (call.reasoningTokens ?? 0), 0),
          // A failed call's cost is unknown (the provider may have billed it).
          costUsd: sumKnown(calls.map((call) => call.costUsd)),
          embeddingCalls: embeddings.length,
          embeddingTexts: embeddings.reduce((sum, call) => sum + call.texts, 0),
          embeddingInputTokens: embeddings.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
          embeddingCostUsd: sumKnown(embeddings.map((call) => call.costUsd)),
        },
        ...(content ? { content } : {}),
      };
      const file = join(options.out, set.id, `run-${run}.json`);
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
      const stats = content?.generation.stats;
      console.log(
        `${set.id} run ${run}: ${record.status}${failure ? ` (${failure.code}: ${failure.message})` : ""}; ` +
          (stats
            ? `found ${stats.found}, not_found ${stats.notFound}, unverified ${stats.unverified}, failed rows ${stats.failedRows}; `
            : "") +
          `${record.totals.calls} calls, ${record.totals.inputTokens} in / ${record.totals.outputTokens} out tokens, ` +
          `cost ${record.totals.costUsd === null ? "unknown" : `$${record.totals.costUsd.toFixed(5)}`}, ` +
          `${record.totals.embeddingCalls} embedding calls, ${(wallMs / 1000).toFixed(1)} s → ${file}`,
      );
    }
  }
}

/* ----------------------------------------------------------------- scoring */

async function score(options: {
  results: string;
  setDirs: string[];
  judgments: string | null;
  out: string;
}) {
  const overrideDirs = new Map<string, string>();
  for (const dir of options.setDirs) {
    overrideDirs.set((await parseEvalSet(dir)).id, resolve(dir));
  }

  const runFiles: RunFile[] = [];
  for (const entry of await readdir(options.results, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of (await readdir(join(options.results, entry.name))).sort()) {
      if (!/^run-\d+\.json$/.test(name)) continue;
      const record = JSON.parse(await readFile(join(options.results, entry.name, name), "utf8")) as RunFile;
      if (record.format !== RUN_FORMAT) {
        throw new Error(`${join(options.results, entry.name, name)} is not a ${RUN_FORMAT} file`);
      }
      runFiles.push(record);
    }
  }
  if (runFiles.length === 0) throw new Error(`no run files under ${options.results}`);

  const sets = new Map<string, EvalSetScoreInput>();
  for (const record of runFiles) {
    if (sets.has(record.set.id)) continue;
    const dir = overrideDirs.get(record.set.id) ?? record.set.dir;
    const parsed = referenceSchema.safeParse(
      JSON.parse(await readFile(join(dir, "reference.json"), "utf8")) as unknown,
    );
    if (!parsed.success) {
      throw new Error(`${join(dir, "reference.json")}: ${z.prettifyError(parsed.error)}`);
    }
    sets.set(record.set.id, {
      id: record.set.id,
      columns: record.set.columns.map(({ id, type }) => ({ id, type })),
      sourceIds: record.set.sourceIds,
      reference: parsed.data.cells,
    });
  }

  const runs: EvalRunScoreInput[] = runFiles.map((record) => ({
    setId: record.set.id,
    run: record.run,
    status: record.status,
    ...(record.error ? { errorCode: record.error.code } : {}),
    rowStatus: record.rowStatus,
    cells: Object.fromEntries(
      Object.entries(record.cells).map(([source, byColumn]) => [
        source,
        Object.fromEntries(
          Object.entries(byColumn).map(([column, cell]) => [
            column,
            cell.status === "found" ? { status: "found" as const, value: cell.value ?? "" } : { status: cell.status },
          ]),
        ),
      ]),
    ),
    usage: {
      calls: record.totals.calls,
      inputTokens: record.totals.inputTokens,
      outputTokens: record.totals.outputTokens,
      costUsd: record.totals.costUsd,
    },
  }));

  let judgments: Judgments | undefined;
  if (options.judgments) {
    const parsed = z
      .record(z.string(), z.enum(["match", "mismatch"]))
      .safeParse(JSON.parse(await readFile(options.judgments, "utf8")) as unknown);
    if (!parsed.success) {
      throw new Error(`${options.judgments}: ${z.prettifyError(parsed.error)}`);
    }
    judgments = parsed.data;
  }

  const result = scoreRuns({ sets: [...sets.values()], runs, ...(judgments ? { judgments } : {}) });
  const csvPath = options.out.replace(/(\.md)?$/i, ".cells.csv");
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(csvPath, cellsToCsv(result.cells));
  await writeFile(
    options.out,
    formatScoreReport(result, {
      generatedAt: new Date().toISOString(),
      judgmentsFile: options.judgments,
      resultsDir: options.results,
    }),
  );
  const o = result.overall;
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  console.log(
    `${runs.length} runs in ${sets.size} set(s): agreement ${pct(o.agreementRate)} (upper ${pct(o.agreementUpperBound)}, ${o.unjudged} unjudged), ` +
      `miss ${pct(o.missRate)}, wrong fill ${pct(o.wrongFillRate)}, unverified ${pct(o.unverifiedShare)}, ` +
      `number exact ${pct(o.numberExactRate)}, run success ${pct(o.runSuccessRate)}`,
  );
  console.log(`report → ${options.out}\ncells  → ${csvPath}`);
}

/* -------------------------------------------------------------------- size */

async function size(options: { out: string; db: boolean }) {
  const content = buildWorstCaseTable();
  const measure = measureTableSize(content, { iterations: 20 });
  const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
  const ms = (t: { median: number; min: number; max: number }) =>
    `${t.median.toFixed(2)} ms (min ${t.min.toFixed(2)}, max ${t.max.toFixed(2)})`;

  let dbLines = [
    "Not measured: run with `--db` to time a jsonb round trip against DATABASE_URL.",
  ];
  if (options.db) {
    const { db } = await import("@sourceweft/db");
    const { sql } = await import("drizzle-orm");
    const json = JSON.stringify(content);
    const samples: number[] = [];
    let storedBytes = 0;
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      await db.transaction(async (tx) => {
        await tx.execute(sql`create temporary table eval_table_size (content jsonb) on commit drop`);
        await tx.execute(sql`insert into eval_table_size (content) values (${json}::jsonb)`);
        const rows = await tx.execute(
          sql`select content::text as text, pg_column_size(content) as stored from eval_table_size`,
        );
        const row = (rows as unknown as { rows?: { text: string; stored: number }[] }).rows?.[0] ??
          (rows as unknown as { text: string; stored: number }[])[0];
        storedBytes = Number(row?.stored ?? 0);
        JSON.parse(String(row?.text ?? "null"));
      });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    dbLines = [
      "Insert into a temporary jsonb table, select it back as text and JSON.parse it, in one transaction (10 runs).",
      "",
      `- Median ${samples[5]!.toFixed(1)} ms (min ${samples[0]!.toFixed(1)}, max ${samples[9]!.toFixed(1)}).`,
      `- Stored size (pg_column_size, after TOAST compression): ${kib(storedBytes)}.`,
      "- The filler text repeats, so this compresses better than real text would.",
      "- Not the artifact_versions write path (no indexes, triggers or row overhead).",
    ];
  }

  const lines = [
    "# Data table evaluation: content size",
    "",
    `Generated ${new Date().toISOString()}. No model call.`,
    "",
    "Worst case built from the table content contract: 50 sources × 8 columns, Chinese, every cell `found` with a 300-character value and 2 evidence items with 300-character quotes, 60-character column names, 200-character descriptions, a 300-character instruction.",
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Serialized size (UTF-8 JSON) | ${measure.bytes} bytes (${kib(measure.bytes)}) |`,
    `| Limit (TABLE_PAYLOAD_MAX_BYTES) | ${measure.limitBytes} bytes (${kib(measure.limitBytes)}) |`,
    `| Over the limit | ${measure.overLimit ? `yes, by ${kib(measure.bytes - measure.limitBytes)}` : "no"} |`,
    `| With one evidence per cell (the engine's fallback) | ${measure.bytesWithOneEvidence} bytes (${kib(measure.bytesWithOneEvidence)}), ${measure.overLimitWithOneEvidence ? "still over: the engine fails with INPUT_TOO_LARGE" : "fits"} |`,
    `| JSON.stringify | ${ms(measure.serializeMs)} |`,
    `| JSON.parse | ${ms(measure.parseMs)} |`,
    `| tableContentSchema.parse | ${ms(measure.validateMs)} |`,
    "",
    "## Database round trip",
    "",
    ...dbLines,
    "",
  ];
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, lines.join("\n"));
  console.log(lines.join("\n"));
}

/* --------------------------------------------------------------------- cli */

const { values: cli } = parseArgs({
  options: {
    set: { type: "string", multiple: true },
    runs: { type: "string" },
    out: { type: "string" },
    score: { type: "boolean" },
    results: { type: "string" },
    judgments: { type: "string" },
    size: { type: "boolean" },
    db: { type: "boolean" },
    "chat-target": { type: "string" },
    "structured-output": { type: "string" },
  },
  strict: true,
});

function usage(message: string): never {
  console.error(`${message}\n\nUsage:
  eval-table.ts --set <dir> [--set <dir> ...] --runs <n> --out <dir>
                [--chat-target deepinfra --structured-output as-production|strict]
  eval-table.ts --score --results <dir> [--judgments <file>] [--set <dir> ...] --out <report.md>
  eval-table.ts --size --out <report.md> [--db]`);
  process.exit(2);
}

try {
  if (!cli.out) usage("--out is required");
  const out = resolve(cli.out);
  if (cli.size) {
    await size({ out, db: cli.db === true });
  } else if (cli.score) {
    if (!cli.results) usage("--results is required with --score");
    await score({
      results: resolve(cli.results),
      setDirs: (cli.set ?? []).map((dir) => resolve(dir)),
      judgments: cli.judgments ? resolve(cli.judgments) : null,
      out,
    });
  } else {
    const setDirs = (cli.set ?? []).map((dir) => resolve(dir));
    if (setDirs.length === 0) usage("at least one --set is required");
    const runs = Number.parseInt(cli.runs ?? "", 10);
    if (!Number.isInteger(runs) || runs < 1) usage("--runs must be a positive integer");
    const chatTarget = cli["chat-target"];
    const structuredOutput = cli["structured-output"];
    if (chatTarget !== undefined && chatTarget !== "deepinfra") {
      usage("--chat-target accepts only deepinfra");
    }
    if (chatTarget === undefined && structuredOutput !== undefined) {
      usage("--structured-output applies only with --chat-target");
    }
    if (chatTarget && structuredOutput !== "as-production" && structuredOutput !== "strict") {
      // No default: production DeepInfra does not declare json_schema_strict,
      // so the choice between matching it and forcing strict output is explicit.
      usage("--chat-target deepinfra needs --structured-output as-production or strict");
    }
    await generate({
      setDirs,
      runs,
      out,
      chatTarget: chatTarget
        ? { kind: "deepinfra", structuredOutput: structuredOutput as "as-production" | "strict" }
        : { kind: "default-profile" },
    });
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
}
