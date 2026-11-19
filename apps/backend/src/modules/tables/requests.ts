import {
  parseTableContent,
  tableRegenerateRequestSchema,
  type TableColumnInput,
  type TableContent,
  type TableFreshness,
  type TableGenerateRequest,
  type TableRegenerateRequest,
  type TableSuggestColumnsRequest,
} from "@sourceweft/contracts/table";
import { openArtifact } from "../artifacts/publish";
import {
  findArtifactRecord,
  findArtifactRecordByRequestKey,
} from "../artifacts/repository";
import { ContentError } from "../content/errors";
import type { ContentBillingPort } from "../content/billing-port";
import { enqueueTableGenerateJob, type TableGenerateJobPayload } from "../content/queue";
import {
  requireGeneratingThread,
  requireViewableArtifact,
  withGroundedErrors,
} from "../grounded-generation/access";
import {
  countRunningGroundedJobs,
  GROUNDED_MAX_RUNNING_PER_USER,
} from "../grounded-generation/artifact-store";
import { checkGroundedSources } from "../grounded-generation/corpus-loader";
import { loadInputFreshness } from "../grounded-generation/freshness";
import {
  GROUNDED_REQUEST_DEDUPE_WINDOW_MS,
  groundedRequestKey,
} from "../grounded-generation/request-key";
import { requireContentWorkspace } from "../workspace/guards";
import { loadTableGeneration } from "./capability";
import { loadTableSources } from "./corpus-loader";
import { findTableVersionContent, writeTablePayloadKey } from "./repository";
import { resolveTableLanguage, suggestTableColumns } from "./service";

/** A double click within this window opens the same table once. */
export const TABLE_REQUEST_DEDUPE_WINDOW_MS = GROUNDED_REQUEST_DEDUPE_WINDOW_MS;

function tableTitle(titles: readonly string[]) {
  const first = titles[0]?.trim() || "Sources";
  const more = titles.length > 1 ? ` +${titles.length - 1}` : "";
  return `Table: ${first}${more}`.slice(0, 200);
}

/**
 * "The table for this request": same person, thread, sources, columns,
 * instruction and language within the same five-minute window. Source order
 * does not matter; column order does, because it is the table's order.
 */
export function tableRequestKey(
  input: {
    userId: string;
    threadId: string;
    sourceIds: readonly string[];
    columns: readonly TableColumnInput[];
    instruction?: string | undefined;
    language?: string | undefined;
  },
  now = Date.now(),
) {
  return groundedRequestKey(
    "table",
    {
      userId: input.userId,
      threadId: input.threadId,
      artifactType: "table",
      sourceIds: [...new Set(input.sourceIds)].sort(),
      columns: input.columns.map((column) => ({
        id: column.id,
        name: column.name,
        description: column.description,
        type: column.type,
      })),
      instruction: input.instruction ?? "",
      language: input.language ?? "",
    },
    now,
  );
}

async function assertBelowRunningLimit(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  if ((await countRunningGroundedJobs(input)) >= GROUNDED_MAX_RUNNING_PER_USER) {
    throw new ContentError(
      429,
      "TABLE_TOO_MANY_RUNNING",
      `At most ${GROUNDED_MAX_RUNNING_PER_USER} tables and study artifacts can be generated at once`,
    );
  }
}

export type TableRequestResult = {
  artifactId: string;
  versionNo: number;
  status: "pending";
  visibility: "private" | "workspace";
  reused: boolean;
};

/** The artifact an identical earlier request opened, without creating one. */
async function findReusedArtifact(
  context: { teamId: string; workspaceId: string; threadId: string; userId: string },
  requestKey: string,
): Promise<{ artifactId: string; reused: boolean } | null> {
  const existing = await findArtifactRecordByRequestKey({
    ...context,
    artifactType: "table",
    requestKey,
    statuses: ["pending", "running", "ready"],
  });
  return existing ? { artifactId: existing.id, reused: true } : null;
}

/**
 * Opens a pending table in a thread and queues its generation. The artifact's
 * visibility follows its thread (the requested one is not a separate control).
 * A repeat of the same request within five minutes returns the same table and
 * queues nothing.
 */
export async function requestTableArtifact(input: {
  workspaceId: string;
  userId: string;
  uiLocale: string;
  request: TableGenerateRequest;
}): Promise<TableRequestResult> {
  return withGroundedErrors(async () => {
    const { workspace, thread } = await requireGeneratingThread({
      workspaceId: input.workspaceId,
      userId: input.userId,
      threadId: input.request.threadId,
    });
    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    };
    const sources = await checkGroundedSources({
      ...scope,
      sourceIds: input.request.sourceIds,
    });
    const requestKey = tableRequestKey({
      userId: input.userId,
      threadId: thread.id,
      sourceIds: input.request.sourceIds,
      columns: input.request.columns,
      instruction: input.request.instruction,
      language: input.request.language,
    });
    const context = { ...scope, threadId: thread.id };

    // A repeat resolves before the limit applies: it starts nothing.
    let opened = await findReusedArtifact(context, requestKey);
    if (!opened) {
      await assertBelowRunningLimit(scope);
      opened = {
        ...(await openArtifact({
          context,
          spec: {
            artifactType: "table",
            title: tableTitle(sources.map((source) => source.title)),
            ...(input.request.instruction ? { prompt: input.request.instruction } : {}),
            payload: {
              table: {
                progress: { stage: "fill", done: 0, total: sources.length },
              },
            },
            idempotency: { requestKey },
          },
        })),
      };
    }
    const record = await findArtifactRecord({
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      artifactId: opened.artifactId,
    });
    if (!opened.reused) {
      const payload: TableGenerateJobPayload = {
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        threadId: thread.id,
        artifactId: opened.artifactId,
        versionNo: 1,
        userId: input.userId,
        sourceIds: input.request.sourceIds,
        columns: input.request.columns,
        ...(input.request.instruction ? { instruction: input.request.instruction } : {}),
        ...(input.request.language ? { language: input.request.language } : {}),
        uiLocale: input.uiLocale,
      };
      await enqueueTableGenerateJob(payload);
    }
    return {
      artifactId: opened.artifactId,
      versionNo: Math.max(1, record?.currentVersionNo ?? 1),
      status: "pending",
      visibility: record?.visibility ?? "workspace",
      reused: opened.reused,
    };
  });
}

function requireViewableTableArtifact(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
}) {
  return requireViewableArtifact(input, ["table"]);
}

async function currentTableContent(artifact: {
  id: string;
  teamId: string;
  workspaceId: string;
  currentVersionNo: number;
}): Promise<TableContent | null> {
  const raw = await findTableVersionContent({
    artifactId: artifact.id,
    teamId: artifact.teamId,
    workspaceId: artifact.workspaceId,
    versionNo: artifact.currentVersionNo,
  });
  if (!raw) return null;
  try {
    return parseTableContent(raw);
  } catch {
    return null;
  }
}

/**
 * Queues version n+1 of a ready table. Whatever the request leaves out is taken
 * from the current version's recipe: the sources, the columns (with the ids the
 * table already has), the instruction, and the language the table was made in,
 * so unchanged cells stay reusable. The ready version stays visible until the
 * new one publishes. A second regeneration of the same version while one is
 * queued is a conflict.
 */
export async function requestTableRegeneration(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
  uiLocale: string;
  body: TableRegenerateRequest;
}): Promise<{ artifactId: string; versionNo: number; status: "pending" }> {
  return withGroundedErrors(async () => {
    const { workspace, artifact } = await requireViewableTableArtifact(input);
    if (artifact.status !== "ready" || artifact.currentVersionNo < 1) {
      throw new ContentError(409, "TABLE_NOT_READY", "Only a ready table can be regenerated");
    }
    const content = await currentTableContent(artifact);
    if (!content) {
      throw new ContentError(409, "TABLE_CONTENT_UNREADABLE", "The current version cannot be read");
    }
    const recipe = content.generation.recipe;
    const sourceIds = input.body.sourceIds ?? recipe.sourceIds;
    const columns = input.body.columns ?? recipe.columns;
    const instruction = input.body.instruction ?? recipe.instruction;
    const language = input.body.language ?? content.language;

    // The request schema only sees what was sent. When one side comes from the
    // recipe, the table that would result is checked here by the same rules.
    const merged = tableRegenerateRequestSchema.safeParse({ sourceIds, columns });
    if (!merged.success) {
      throw new ContentError(
        422,
        "VALIDATION_ERROR",
        merged.error.issues[0]?.message ?? "Invalid request body",
        { details: merged.error.flatten() },
      );
    }

    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    };
    await checkGroundedSources({ ...scope, sourceIds });
    await assertBelowRunningLimit(scope);
    const versionNo = artifact.currentVersionNo + 1;
    const queued = await enqueueTableGenerateJob({
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      threadId: artifact.threadId ?? "",
      artifactId: artifact.id,
      versionNo,
      userId: input.userId,
      sourceIds,
      columns,
      ...(instruction ? { instruction } : {}),
      language,
      uiLocale: input.uiLocale,
    });
    if (!queued.created) {
      throw new ContentError(
        409,
        "TABLE_REGENERATION_IN_PROGRESS",
        "This version is already being regenerated",
      );
    }
    await writeTablePayloadKey(
      { artifactId: artifact.id, teamId: artifact.teamId, workspaceId: artifact.workspaceId },
      "regeneration",
      { versionNo, status: "running" },
    );
    return { artifactId: artifact.id, versionNo, status: "pending" };
  });
}

/**
 * Whether the sources of the current version have changed since, row by row:
 * each row remembers the hash of the source it was read from.
 */
export async function getTableFreshness(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
}): Promise<TableFreshness> {
  const { artifact } = await requireViewableTableArtifact(input);
  const content = await currentTableContent(artifact);
  if (!content) {
    throw new ContentError(409, "TABLE_NOT_READY", "The table has no readable version");
  }
  return loadInputFreshness({
    teamId: artifact.teamId,
    workspaceId: artifact.workspaceId,
    inputs: { sources: content.rows },
  });
}

export type TableEstimate = {
  /** Selected sources, including those that cannot be read yet. */
  sources: number;
  /** Sources that are not indexed yet; their rows will be skipped. */
  skippedSources: number;
  columns: number;
  /** Cells the model has to fill: readable sources × columns. */
  cells: number;
  /** Model calls the fill needs (a long source takes one per group). */
  calls: number;
  inputTokensEstimate: number;
  exceedsLimit: boolean;
};

/**
 * The size of a generation, without calling a model: how many cells and calls
 * and how many input tokens. Credits are not estimated (there is no price
 * conversion to reuse); the UI shows the size.
 */
export async function estimateTable(input: {
  workspaceId: string;
  userId: string;
  uiLocale: string;
  request: TableGenerateRequest;
}): Promise<TableEstimate> {
  return withGroundedErrors(async () => {
    const { workspace } = await requireGeneratingThread({
      workspaceId: input.workspaceId,
      userId: input.userId,
      threadId: input.request.threadId,
    });
    const loaded = await loadTableSources({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceIds: input.request.sourceIds,
    });
    const generation = await loadTableGeneration();
    const columns = generation.resolveColumns(input.request.columns);
    const plan = generation.planFill({
      columns,
      sources: loaded.sources,
      language: resolveTableLanguage({
        requested: input.request.language,
        sources: loaded.sources,
        uiLocale: input.uiLocale,
      }),
    });
    return {
      sources: loaded.sources.length,
      skippedSources: loaded.sources.filter((source) => !source.indexed).length,
      columns: columns.length,
      cells: plan.cellsToFill,
      calls: plan.calls,
      inputTokensEstimate: plan.totalTokens,
      exceedsLimit: plan.exceedsLimit,
    };
  });
}

/**
 * Proposes columns for the selected sources: one synchronous model call that
 * the requester pays for.
 */
export async function requestTableColumnSuggestions(input: {
  workspaceId: string;
  userId: string;
  uiLocale: string;
  billing: ContentBillingPort;
  request: TableSuggestColumnsRequest;
}): Promise<{ columns: TableColumnInput[] }> {
  return withGroundedErrors(async () => {
    const workspace = await requireContentWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const columns = await suggestTableColumns(
      {
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        sourceIds: input.request.sourceIds,
        ...(input.request.instruction ? { instruction: input.request.instruction } : {}),
        ...(input.request.language ? { language: input.request.language } : {}),
        uiLocale: input.uiLocale,
      },
      { billing: input.billing },
    );
    return { columns };
  });
}
