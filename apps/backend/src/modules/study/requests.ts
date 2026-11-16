import { createHash } from "node:crypto";
import {
  parseStudyContentForArtifact,
  STUDY_ARTIFACT_TYPES,
  studyOptionsSchema,
  type StudyErrorCode,
  type StudyGenerateRequest,
  type StudyKind,
  type StudyOptions,
} from "@sourceweft/contracts/study";
import { z } from "zod";
import { openArtifact } from "../artifacts/publish";
import {
  findArtifactRecord,
  findArtifactRecordByRequestKey,
} from "../artifacts/repository";
import { ContentError } from "../content/errors";
import {
  enqueueStudyGenerateJob,
  type StudyGenerateJobPayload,
} from "../content/queue";
import { findThreadRecord } from "../threads/thread/repository";
import { canViewContent, canViewThread } from "../workspace/content-visibility";
import { requireContentWorkspace } from "../workspace/guards";
import { checkStudySources, loadStudyCorpus } from "./corpus-loader";
import { isStudyGenerationError } from "@sourceweft/contracts/study-capability";
import { loadStudyGeneration } from "./capability";
import { loadStudyFreshness, type StudyFreshness } from "./freshness";
import {
  countRunningStudyJobs,
  findStudyVersionContent,
  STUDY_MAX_RUNNING_PER_USER,
  writeStudyPayloadKey,
} from "./repository";

/** A double click within this window opens the same artifact once. */
export const STUDY_REQUEST_DEDUPE_WINDOW_MS = 5 * 60_000;

const ERROR_STATUS: Record<StudyErrorCode, number> = {
  SOURCE_NOT_READABLE: 404,
  NO_INDEXED_SOURCES: 409,
  INPUT_TOO_LARGE: 413,
  INSUFFICIENT_CREDITS: 402,
  MODEL_UNAVAILABLE: 503,
  GENERATION_QUALITY_TOO_LOW: 422,
};

/** Study failures raised while handling a request become API errors. */
export function toStudyContentError(error: unknown): unknown {
  if (isStudyGenerationError(error)) {
    return new ContentError(ERROR_STATUS[error.code], error.code, error.message, {
      details: error.details,
    });
  }
  return error;
}

async function withStudyErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toStudyContentError(error);
  }
}

const TYPE_LABEL: Record<StudyKind, string> = {
  flashcards: "Flashcards",
  quiz: "Quiz",
  mindmap: "Mind map",
};

function studyTitle(kind: StudyKind, titles: readonly string[]) {
  const first = titles[0]?.trim() || "Sources";
  const more = titles.length > 1 ? ` +${titles.length - 1}` : "";
  return `${TYPE_LABEL[kind]}: ${first}${more}`.slice(0, 200);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * "The artifact for this request": same person, thread, type, sources and
 * options within the same five-minute window.
 */
export function studyRequestKey(
  input: {
    userId: string;
    threadId: string;
    artifactType: StudyKind;
    sourceIds: readonly string[];
    options?: StudyOptions;
  },
  now = Date.now(),
) {
  const window = Math.floor(now / STUDY_REQUEST_DEDUPE_WINDOW_MS);
  const material = stableJson({
    userId: input.userId,
    threadId: input.threadId,
    artifactType: input.artifactType,
    sourceIds: [...new Set(input.sourceIds)].sort(),
    options: input.options ?? {},
    window,
  });
  return `study:${createHash("sha256").update(material).digest("hex").slice(0, 40)}`;
}

async function requireStudyThread(input: {
  workspaceId: string;
  userId: string;
  threadId: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const thread = await findThreadRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: input.threadId,
  });
  if (!thread || !canViewThread(input.userId, thread)) {
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  }
  return { workspace, thread };
}

async function assertBelowRunningLimit(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  if ((await countRunningStudyJobs(input)) >= STUDY_MAX_RUNNING_PER_USER) {
    throw new ContentError(
      429,
      "STUDY_TOO_MANY_RUNNING",
      `At most ${STUDY_MAX_RUNNING_PER_USER} study artifacts can be generated at once`,
    );
  }
}

export type StudyRequestResult = {
  artifactId: string;
  versionNo: number;
  status: "pending";
  visibility: "private" | "workspace";
  reused: boolean;
};

/**
 * Opens a pending study artifact in a thread and queues its generation. The
 * artifact's visibility follows its thread (the requested one is not a
 * separate control). A repeat of the same request within five minutes returns
 * the same artifact and queues nothing.
 */
export async function requestStudyArtifact(input: {
  workspaceId: string;
  userId: string;
  uiLocale: string;
  request: StudyGenerateRequest;
}): Promise<StudyRequestResult> {
  return withStudyErrors(async () => {
    const { workspace, thread } = await requireStudyThread({
      workspaceId: input.workspaceId,
      userId: input.userId,
      threadId: input.request.threadId,
    });
    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    };
    const sources = await checkStudySources({
      ...scope,
      sourceIds: input.request.sourceIds,
    });
    const requestKey = studyRequestKey({
      userId: input.userId,
      threadId: thread.id,
      artifactType: input.request.artifactType,
      sourceIds: input.request.sourceIds,
      ...(input.request.options ? { options: input.request.options } : {}),
    });
    const spec = {
      artifactType: input.request.artifactType,
      title: studyTitle(
        input.request.artifactType,
        sources.map((source) => source.title),
      ),
      ...(input.request.options?.focus
        ? { prompt: input.request.options.focus }
        : {}),
      payload: { study: { progress: { stage: "assemble", done: 0, total: 1 } } },
      idempotency: { requestKey },
    };
    const context = { ...scope, threadId: thread.id };

    // A repeat resolves before the limit applies: it starts nothing.
    let opened: { artifactId: string; reused: boolean } | null =
      await openArtifactIfReused(context, spec);
    if (!opened) {
      await assertBelowRunningLimit(scope);
      opened = await openArtifact({ context, spec });
    }
    const record = await findArtifactRecord({
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      artifactId: opened.artifactId,
    });
    if (!opened.reused) {
      const payload: StudyGenerateJobPayload = {
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        threadId: thread.id,
        artifactId: opened.artifactId,
        versionNo: 1,
        userId: input.userId,
        artifactType: input.request.artifactType,
        sourceIds: input.request.sourceIds,
        ...(input.request.options ? { options: input.request.options } : {}),
        uiLocale: input.uiLocale,
      };
      await enqueueStudyGenerateJob(payload);
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

/** The artifact an identical earlier request opened, without creating one. */
async function openArtifactIfReused(
  context: { teamId: string; workspaceId: string; threadId: string; userId: string },
  spec: { artifactType: StudyKind; idempotency: { requestKey: string } },
) {
  const existing = await findArtifactRecordByRequestKey({
    ...context,
    artifactType: spec.artifactType,
    requestKey: spec.idempotency.requestKey,
    statuses: ["pending", "running", "ready"],
  });
  return existing ? { artifactId: existing.id, reused: true as const } : null;
}

export const studyRegenerateRequestSchema = z.object({
  options: studyOptionsSchema.optional(),
  focus: z.string().max(200).optional(),
});
export type StudyRegenerateRequest = z.infer<typeof studyRegenerateRequestSchema>;

async function requireViewableStudyArtifact(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const artifact = await findArtifactRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    artifactId: input.artifactId,
  });
  if (
    !artifact ||
    !canViewContent(input.userId, artifact) ||
    !(STUDY_ARTIFACT_TYPES as readonly string[]).includes(artifact.artifactType)
  ) {
    throw new ContentError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
  }
  return { workspace, artifact };
}

async function currentStudyContent(artifact: {
  id: string;
  teamId: string;
  workspaceId: string;
  artifactType: string;
  currentVersionNo: number;
}) {
  const raw = await findStudyVersionContent({
    artifactId: artifact.id,
    teamId: artifact.teamId,
    workspaceId: artifact.workspaceId,
    versionNo: artifact.currentVersionNo,
  });
  if (!raw) return null;
  try {
    return parseStudyContentForArtifact(artifact.artifactType, raw);
  } catch {
    return null;
  }
}

/**
 * Queues version n+1 of a ready study artifact. Options left out are taken
 * from the current version's recipe; the sources are the recipe's. The ready
 * version stays visible until the new one publishes. A second regeneration of
 * the same version while one is queued is a conflict.
 */
export async function requestStudyRegeneration(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
  uiLocale: string;
  body: StudyRegenerateRequest;
}): Promise<{ artifactId: string; versionNo: number; status: "pending" }> {
  return withStudyErrors(async () => {
    const { workspace, artifact } = await requireViewableStudyArtifact(input);
    if (artifact.status !== "ready" || artifact.currentVersionNo < 1) {
      throw new ContentError(409, "STUDY_NOT_READY", "Only a ready study artifact can be regenerated");
    }
    const content = await currentStudyContent(artifact);
    if (!content) {
      throw new ContentError(409, "STUDY_CONTENT_UNREADABLE", "The current version cannot be read");
    }
    const recipe = content.generation.recipe;
    const options: StudyOptions = { ...recipe.options, ...input.body.options };
    const focus = input.body.focus ?? input.body.options?.focus ?? recipe.focus;
    if (focus !== undefined) options.focus = focus;
    else delete options.focus;

    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    };
    await checkStudySources({ ...scope, sourceIds: recipe.sourceIds });
    await assertBelowRunningLimit(scope);
    const versionNo = artifact.currentVersionNo + 1;
    const queued = await enqueueStudyGenerateJob({
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      threadId: artifact.threadId ?? "",
      artifactId: artifact.id,
      versionNo,
      userId: input.userId,
      artifactType: artifact.artifactType as StudyKind,
      sourceIds: recipe.sourceIds,
      options,
      uiLocale: input.uiLocale,
    });
    if (!queued.created) {
      throw new ContentError(409, "STUDY_REGENERATION_IN_PROGRESS", "This version is already being regenerated");
    }
    await writeStudyPayloadKey(
      { artifactId: artifact.id, teamId: artifact.teamId, workspaceId: artifact.workspaceId },
      "regeneration",
      { versionNo, status: "running" },
    );
    return { artifactId: artifact.id, versionNo, status: "pending" };
  });
}

/** Whether the sources of the current version have changed since. */
export async function getStudyFreshness(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
}): Promise<StudyFreshness> {
  const { artifact } = await requireViewableStudyArtifact(input);
  const content = await currentStudyContent(artifact);
  if (!content) {
    throw new ContentError(409, "STUDY_NOT_READY", "The study artifact has no readable version");
  }
  return loadStudyFreshness({
    teamId: artifact.teamId,
    workspaceId: artifact.workspaceId,
    inputs: content.inputs,
  });
}

export type StudyEstimate = {
  mode: "single" | "mapreduce";
  inputTokensEstimate: number;
  groups: number;
  maxItems: number;
  exceedsLimit: boolean;
};

/**
 * The size of a generation, without calling a model: estimated input tokens,
 * single pass or map-reduce, group count and item count. Credits are not
 * estimated (there is no price conversion to reuse); the UI shows the size.
 */
export async function estimateStudy(input: {
  workspaceId: string;
  userId: string;
  uiLocale: string;
  request: StudyGenerateRequest;
}): Promise<StudyEstimate> {
  return withStudyErrors(async () => {
    const { workspace } = await requireStudyThread({
      workspaceId: input.workspaceId,
      userId: input.userId,
      threadId: input.request.threadId,
    });
    const corpus = await loadStudyCorpus({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      sourceIds: input.request.sourceIds,
    });
    const generation = await loadStudyGeneration();
    const options = generation.resolveStudyOptions({
      kind: input.request.artifactType,
      ...(input.request.options ? { options: input.request.options } : {}),
      chunks: corpus.chunks,
      uiLocale: input.uiLocale,
    });
    const measure = generation.measureCorpus(corpus.chunks);
    return {
      mode: measure.mode,
      inputTokensEstimate: measure.totalTokens,
      groups: measure.groups,
      maxItems: options.count,
      exceedsLimit: measure.exceedsLimit,
    };
  });
}
