import type { Job } from "bullmq";
import ts from "typescript";
import { z } from "zod";
import {
  videoPresentationCreateRequestSchema,
  videoPresentationProjectPayloadSchema,
  type VideoPresentationAsset,
  type VideoPresentationAssetRef,
  type VideoPresentationAudioTrack,
  type VideoPresentationCreateRequest,
  type VideoPresentationGenerationStage,
  type VideoPresentationProjectPayload,
  type VideoPresentationSceneModule,
  type VideoPresentationThemeAssignment,
} from "@sourceweft/contracts/video-presentation";
import type {
  ChatCompleteInput,
  ModelGateway,
  ThinkingConfig,
  TtsSpeechInput,
} from "@sourceweft/model-gateway";
import type { VideoPresentationGenerateJobPayload } from "../../modules/content/queue";
import { ContentError } from "../../modules/content/errors";
import {
  buildGatewayRequestMetadata,
  type LlmExecutionConfig,
} from "../../modules/content/model-gateway-audit";
import { logger } from "../../shared/logger";

const VIDEO_SCENE_COMPONENT_NAME = "VideoScene";
const MAX_REPAIR_ATTEMPTS = 3;
const MAX_LLM_EMPTY_RETRIES = 2;
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_DIAGNOSTIC_LENGTH = 2000;
const VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE =
  "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE";
const VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED =
  "VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED";
const VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED =
  "VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED";
const VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED =
  "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED";

const STAGE_PROGRESS: Record<VideoPresentationGenerationStage, number> = {
  planning: 0,
  generating_project_code: 8,
  planning_storyboard: 16,
  materializing_assets: 28,
  generating_audio_tracks: 40,
  assigning_slide_themes: 52,
  generating_scene_modules: 64,
  repairing_scene_modules: 76,
  installing_project: 84,
  typechecking_project: 88,
  rendering_smoke_preview: 92,
  publishing_video_project: 96,
  ready: 100,
  failed: 100,
};

const THEME_PRESETS = [
  "TERRA",
  "OCEAN",
  "SUNSET",
  "EMERALD",
  "ECLIPSE",
  "FROST",
  "NEBULA",
  "AURORA",
  "MIDNIGHT",
  "AMBER",
] as const;

const THEME_DESCRIPTIONS = `
TERRA: warm earth tones, terracotta, olive, organic warmth
OCEAN: teal depth, coral accents, calm and fluid
SUNSET: orange and purple energy, bold and expressive
EMERALD: green and mint, growth and clarity
ECLIPSE: black and gold, dramatic premium contrast
FROST: ice blue and silver, crisp technical clarity
NEBULA: magenta and deep purple, futuristic and mysterious
AURORA: green teal and violet, luminous transformation
MIDNIGHT: navy and silver, contemplative authority
AMBER: honey warmth and brown, wisdom and craft
`.trim();

type Stage = Exclude<VideoPresentationGenerationStage, "planning">;

type WorkerChatMessage = ChatCompleteInput["messages"][number];

type WorkerLlmInput = {
  messages: WorkerChatMessage[];
  maxTokens?: number;
  metadata: Record<string, unknown>;
  temperature?: number;
};

type StructuredValidationVerdict =
  | { ok: true }
  | { ok: false; feedback: string };

type WorkerStructuredLlmInput = WorkerLlmInput & {
  schema: Record<string, unknown>;
  schemaName: string;
  /**
   * Optional acceptance check on the parsed structured output. When it rejects,
   * completeStructured makes exactly one repair call on the same model with the
   * returned feedback before giving up.
   */
  validate?: (parsed: unknown) => StructuredValidationVerdict;
};

export type VideoPresentationWorkerDeps = {
  artifacts: {
    find(input: {
      artifactId: string;
      teamId: string;
      workspaceId: string;
    }): Promise<{ payloadJson?: unknown } | null>;
    markFailed(input: {
      artifactId: string;
      teamId?: string;
      workspaceId?: string;
      expectedStatuses?: Array<"pending" | "running" | "ready" | "failed">;
      errorCode: string;
      errorMessage: string;
      payload?: Record<string, unknown>;
    }): Promise<unknown>;
    markReady(input: {
      artifactId: string;
      teamId: string;
      workspaceId: string;
      userId: string;
      payload: Record<string, unknown>;
    }): Promise<{
      artifactId: string;
      versionId: string;
    }>;
    markRunning(input: {
      artifactId: string;
      teamId?: string;
      workspaceId?: string;
      expectedStatuses?: Array<"pending" | "running" | "ready" | "failed">;
      payload?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  llm: {
    complete(input: WorkerLlmInput): Promise<string>;
    completeStructured(input: WorkerStructuredLlmInput): Promise<unknown>;
  };
  storage: {
    buildArtifactStorageKey(input: {
      artifactId: string;
      fileName: string;
      workspaceId: string;
    }): string;
    getBucketName(): string;
    upload(input: {
      body: Buffer;
      contentType: string;
      key: string;
    }): Promise<void>;
  };
  tts: {
    speech(input: {
      metadata: Record<string, unknown>;
      text: string;
    }): Promise<{ audio: Buffer; mimeType: string }>;
  };
  sandbox?: {
    runProject(input: {
      payload: VideoPresentationProjectPayload;
      request: VideoPresentationCreateRequest;
      job: VideoPresentationGenerateJobPayload;
    }): Promise<{
      install: ProjectExecutionResult;
      typecheck: ProjectExecutionResult;
      smoke: ProjectExecutionResult;
    }>;
  };
};

type ProjectExecutionResult = {
  ok: boolean;
  diagnostics: string[];
  stdout?: string;
  stderr?: string;
};

type SandboxExecuteLikeResult = {
  exitCode: number | null;
  output: string;
  truncated?: boolean;
};

function stageProgress(stage: VideoPresentationGenerationStage) {
  return STAGE_PROGRESS[stage];
}

function resolveJobAttempt(job: Job<Record<string, unknown>>) {
  return (typeof job.attemptsMade === "number" ? job.attemptsMade : 0) + 1;
}

function resolveJobMaxAttempts(job: Job<Record<string, unknown>>) {
  return job.opts?.attempts ?? 1;
}

function isFinalJobAttempt(job: Job<Record<string, unknown>>) {
  return resolveJobAttempt(job) >= resolveJobMaxAttempts(job);
}

async function updateVideoPresentationJobProgress(
  job: Job<Record<string, unknown>>,
  generation: VideoPresentationProjectPayload["generation"],
) {
  const updateProgress = (
    job as Job<Record<string, unknown>> & {
      updateProgress?: (value: unknown) => Promise<void>;
    }
  ).updateProgress;
  if (typeof updateProgress !== "function") {
    return;
  }
  await updateProgress.call(job, {
    attempt: generation.attempt,
    maxAttempts: generation.maxAttempts,
    progress: generation.progress,
    retrying: generation.retrying ?? false,
    stage: generation.stage,
    status: generation.status,
  });
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function truncateDiagnostics(diagnostics: readonly string[]) {
  return diagnostics
    .map((diagnostic) => truncateText(diagnostic.trim(), MAX_DIAGNOSTIC_LENGTH))
    .filter(Boolean);
}

function truncateProjectExecutionResult(
  result: ProjectExecutionResult,
): ProjectExecutionResult {
  return {
    ...result,
    diagnostics: truncateDiagnostics(result.diagnostics),
    ...(typeof result.stdout === "string"
      ? { stdout: truncateText(result.stdout, 10_000) }
      : {}),
    ...(typeof result.stderr === "string"
      ? { stderr: truncateText(result.stderr, 10_000) }
      : {}),
  };
}

function normalizeProjectExecutionResults(input: {
  install: ProjectExecutionResult;
  typecheck: ProjectExecutionResult;
  smoke: ProjectExecutionResult;
}) {
  return {
    install: truncateProjectExecutionResult(input.install),
    typecheck: truncateProjectExecutionResult(input.typecheck),
    smoke: truncateProjectExecutionResult(input.smoke),
  };
}

function buildVideoPresentationSourceJson(
  payload: VideoPresentationProjectPayload,
) {
  return videoPresentationProjectPayloadSchema.parse({
    ...payload,
    generation: {
      ...payload.generation,
    },
  });
}

function attachReadySourceJson(input: {
  artifactId: string;
  jobId: string;
  payload: VideoPresentationProjectPayload;
  workspaceId: string;
}) {
  const sourceJson = buildVideoPresentationSourceJson(input.payload);
  return {
    ...input.payload,
    sourceJson,
    sourceJsonFileName: `${safeStorageSegment(input.payload.project.title)}.source.json`,
    sourceJsonUrl: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/source.json`,
    artifactUrl: `/artifact-preview?${new URLSearchParams({
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
    }).toString()}`,
    fileName: `${safeStorageSegment(input.payload.project.title)}.video-presentation.json`,
    jobId: input.jobId,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    renderStrategy: "frontend_remotion_project_to_video",
    videoDownloadOnly: true,
  };
}

function safeStorageSegment(value: string) {
  return (
    value
      .normalize("NFKC")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "video-presentation"
  );
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectExecutionResultFromSandbox(
  result: SandboxExecuteLikeResult,
): ProjectExecutionResult {
  const output = result.output.trim();
  const ok = result.exitCode === 0;
  return {
    ok,
    diagnostics: ok ? [] : [output || `Command exited with ${result.exitCode}`],
    stdout: ok ? output : "",
    stderr: ok ? "" : output,
  };
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("opus")) return "opus";
  if (mimeType.includes("flac")) return "flac";
  return "mp3";
}

function audioAssetUrl(input: {
  artifactId: string;
  fileName: string;
  workspaceId: string;
}) {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/assets/${encodeURIComponent(input.fileName)}`;
}

function estimateNarrationDurationSeconds(text: string) {
  const cjkChars = [...text].filter((char) =>
    /\p{Script=Han}/u.test(char),
  ).length;
  const wordCount = text
    .replace(/\p{Script=Han}/gu, " ")
    .split(/\s+/u)
    .filter(Boolean).length;
  const estimated = cjkChars > wordCount ? cjkChars / 5.2 : wordCount / 2.45;
  return Math.max(4, Number((estimated + 1.25).toFixed(2)));
}

function durationTargetFallbackSeconds(
  target: VideoPresentationProjectPayload["renderProfile"]["durationTarget"],
) {
  if (target === "short") return 6;
  if (target === "long") return 14;
  return 10;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

function stripMarkdownFences(value: string) {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(
    /^```(?:json|tsx?|jsx?|javascript|typescript)?\s*([\s\S]*?)\s*```$/u,
  );
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  const embeddedFenceMatch = trimmed.match(
    /```(?:tsx?|jsx?|javascript|typescript)?\s*([\s\S]*?)\s*```/u,
  );
  return (embeddedFenceMatch?.[1] ?? trimmed).trim();
}

function extractJsonObject(value: string): Record<string, unknown> | null {
  const text = stripMarkdownFences(value);
  const candidates = [
    text,
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ].filter((candidate) => candidate.trim().startsWith("{"));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // Try the next extraction candidate.
    }
  }
  return null;
}

function extractSceneCodeAndTitle(value: string) {
  const object = extractJsonObject(value);
  if (object && typeof object.code === "string") {
    return {
      code: stripMarkdownFences(object.code),
      title: typeof object.title === "string" ? object.title.trim() : null,
    };
  }
  return { code: stripMarkdownFences(value), title: null };
}

function assetRefsForSlide(input: {
  assetRefs: readonly VideoPresentationAssetRef[];
  assetNeeds: readonly string[];
  sceneIntent: string;
}) {
  const byNeed = input.assetRefs.filter((assetRef) =>
    input.assetNeeds.some((assetNeed) => assetRef.role === assetNeed),
  );
  if (byNeed.length > 0) return byNeed;
  return input.assetRefs.filter((assetRef) =>
    input.sceneIntent.toLowerCase().includes(assetRef.role.toLowerCase()),
  );
}

type PlannedSlide = {
  slideNumber: number;
  title: string;
  subtitle?: string;
  contentMarkdown?: string;
  speakerTranscript: string[];
  backgroundExplanation?: string;
  sceneIntent: string;
  assetNeeds: string[];
};

function storyboardOutputSchema(slideCount: number) {
  const slide = z
    .object({
      slideNumber: z.number().int().min(1).max(slideCount),
      title: z.string().trim().min(1),
      subtitle: z.string().trim().min(1).nullable(),
      contentMarkdown: z.string().trim().min(1).nullable(),
      speakerTranscript: z.array(z.string().trim().min(1)).min(1).max(8),
      backgroundExplanation: z.string().trim().min(1).nullable(),
      sceneIntent: z.string().trim().min(1),
      assetNeeds: z.array(z.string().trim().min(1)).max(4),
    })
    .strict();

  return z
    .object({
      slides: z.array(slide).length(slideCount),
    })
    .strict();
}

function themeAssignmentsOutputSchema(slideCount: number) {
  return z
    .object({
      assignments: z
        .array(
          z
            .object({
              slideNumber: z.number().int().min(1).max(slideCount),
              themeName: z.enum(THEME_PRESETS),
              mode: z.enum(["light", "dark"]),
            })
            .strict(),
        )
        .length(slideCount),
    })
    .strict();
}

function requestRenderProfile(request: VideoPresentationCreateRequest) {
  return {
    stylePreset:
      request.renderProfile?.stylePreset ?? request.stylePreset ?? "cinematic",
    visualDensity: request.renderProfile?.visualDensity ?? "balanced",
    durationTarget:
      request.renderProfile?.durationTarget ??
      request.durationTarget ??
      "medium",
    language: request.renderProfile?.language ?? request.language ?? "auto",
  } satisfies VideoPresentationProjectPayload["renderProfile"];
}

function requestSlideCount(request: VideoPresentationCreateRequest) {
  const target = request.slideCount;
  if (typeof target === "number" && Number.isInteger(target)) {
    return Math.min(12, Math.max(1, target));
  }
  const durationTarget = requestRenderProfile(request).durationTarget;
  if (durationTarget === "short") return 4;
  if (durationTarget === "long") return 8;
  return 6;
}

function requestCanvas(request: VideoPresentationCreateRequest) {
  return {
    width: request.canvas?.width ?? 1920,
    height: request.canvas?.height ?? 1080,
    fps: request.canvas?.fps ?? 30,
  };
}

function formatCustomizationForPrompt(request: VideoPresentationCreateRequest) {
  const parts = [
    request.visualDirection
      ? `Visual direction: ${request.visualDirection}`
      : null,
    request.brand?.colors?.length
      ? `Brand colors: ${request.brand.colors.join(", ")}`
      : null,
    request.brand?.typography
      ? `Typography: ${request.brand.typography}`
      : null,
    request.motion?.pacing ? `Motion pacing: ${request.motion.pacing}` : null,
    request.motion?.transitionStyle
      ? `Transition style: ${request.motion.transitionStyle}`
      : null,
    request.motion?.animationIntensity
      ? `Animation intensity: ${request.motion.animationIntensity}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : "No extra customization.";
}

function requestNarrationEnabled(request: VideoPresentationCreateRequest) {
  return request.narration?.enabled ?? request.narrationEnabled ?? true;
}

function requestBrief(request: VideoPresentationCreateRequest) {
  return (
    request.brief?.trim() ||
    request.sourceDigest?.trim() ||
    request.title?.trim() ||
    "Create a concise video presentation."
  );
}

function normalizePlannedSlides(
  value: z.infer<ReturnType<typeof storyboardOutputSchema>>["slides"],
  expectedSlideCount: number,
) {
  const bySlideNumber = new Map(
    value.map((slide) => [slide.slideNumber, slide]),
  );
  if (
    value.length !== expectedSlideCount ||
    bySlideNumber.size !== expectedSlideCount ||
    Array.from({ length: expectedSlideCount }, (_, index) => index + 1).some(
      (slideNumber) => !bySlideNumber.has(slideNumber),
    )
  ) {
    return null;
  }

  return Array.from(
    { length: expectedSlideCount },
    (_, index): PlannedSlide => {
      const slide = bySlideNumber.get(index + 1)!;
      return {
        slideNumber: slide.slideNumber,
        title: slide.title,
        ...(slide.subtitle ? { subtitle: slide.subtitle } : {}),
        ...(slide.contentMarkdown
          ? { contentMarkdown: slide.contentMarkdown }
          : {}),
        speakerTranscript: slide.speakerTranscript,
        ...(slide.backgroundExplanation
          ? { backgroundExplanation: slide.backgroundExplanation }
          : {}),
        sceneIntent: slide.sceneIntent,
        assetNeeds: slide.assetNeeds,
      };
    },
  );
}

function summarizeStructuredValidationError(input: {
  parsed: unknown;
  zodError?: z.ZodError;
  extra?: string;
}): string {
  const parts: string[] = [];
  if (input.zodError) {
    const issues = input.zodError.issues
      .slice(0, 6)
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `- ${path}: ${issue.message}`;
      })
      .join("\n");
    if (issues) {
      parts.push(`Schema validation errors:\n${issues}`);
    }
  }
  if (input.extra) {
    parts.push(input.extra);
  }
  return parts.join("\n\n") || "The response did not satisfy the requirements.";
}

async function planStoryboard(input: {
  deps: VideoPresentationWorkerDeps;
  request: VideoPresentationCreateRequest;
}) {
  const brief = requestBrief(input.request);
  const renderProfile = requestRenderProfile(input.request);
  const slideCount = requestSlideCount(input.request);
  const outputSchema = storyboardOutputSchema(slideCount);
  let response: unknown;
  try {
    response = await input.deps.llm.completeStructured({
      temperature: 0.55,
      maxTokens: 3200,
      schema: z.toJSONSchema(outputSchema),
      schemaName: "video_presentation_storyboard",
      validate: (parsed) => {
        const check = outputSchema.safeParse(parsed);
        if (!check.success) {
          return {
            ok: false,
            feedback: summarizeStructuredValidationError({
              parsed,
              zodError: check.error,
            }),
          };
        }
        if (!normalizePlannedSlides(check.data.slides, slideCount)) {
          return {
            ok: false,
            feedback: summarizeStructuredValidationError({
              parsed,
              extra: `Provide exactly one complete entry for each slide numbered 1 through ${slideCount}, with no duplicates or gaps.`,
            }),
          };
        }
        return { ok: true };
      },
      metadata: {
        feature: "video_presentation",
        stage: "plan_storyboard",
      },
      messages: [
        {
          role: "system",
          content: [
            "You plan concise narrated video presentations.",
            `Plan exactly ${slideCount} slides and follow the supplied response schema.`,
            "Every slide must use its one-based slideNumber exactly once.",
            "Use null for optional text fields when they are not needed.",
            "Keep narration natural for spoken audio. Do not include code.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Brief:\n${brief}`,
            `Title: ${input.request.title ?? ""}`,
            `Audience: ${input.request.audience ?? ""}`,
            `Tone: ${input.request.tone ?? ""}`,
            `Language: ${renderProfile.language}`,
            `Style: ${renderProfile.stylePreset}`,
            `Duration target: ${renderProfile.durationTarget}`,
            `Target slide count: ${slideCount}`,
            `Customization:\n${formatCustomizationForPrompt(input.request)}`,
          ].join("\n\n"),
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw videoPresentationProviderError(
      VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED,
      `Storyboard provider call failed: ${message}`,
    );
  }

  const parsed = outputSchema.safeParse(response);
  const slides = parsed.success
    ? normalizePlannedSlides(parsed.data.slides, slideCount)
    : null;
  if (!slides) {
    throw videoPresentationProviderError(
      VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED,
      `Storyboard provider returned invalid structured content; expected exactly one complete entry for slides 1-${slideCount}.`,
    );
  }
  return slides;
}

async function planVideoProject(input: {
  current: VideoPresentationProjectPayload;
  deps: VideoPresentationWorkerDeps;
  request: VideoPresentationCreateRequest;
}) {
  const plannedSlides = await planStoryboard({
    deps: input.deps,
    request: input.request,
  });
  const renderProfile = requestRenderProfile(input.request);
  const title =
    input.request.title?.trim() ||
    plannedSlides[0]?.title ||
    input.current.project.title;
  const canvas = requestCanvas(input.request);
  const globalVisualDirection =
    input.request.visualDirection?.trim() ||
    `${renderProfile.stylePreset} ${renderProfile.visualDensity} video presentation with code-generated Remotion scenes.`;
  const assetRefs = input.request.assets ?? [];
  return videoPresentationProjectPayloadSchema.parse({
    ...input.current,
    project: {
      ...input.current.project,
      title,
      fps: canvas.fps,
      width: canvas.width,
      height: canvas.height,
      stylePreset: renderProfile.stylePreset,
      globalVisualDirection,
    },
    renderProfile,
    slides: plannedSlides.map((slide, index) => ({
      slideNumber: index + 1,
      title: slide.title,
      ...(slide.subtitle ? { subtitle: slide.subtitle } : {}),
      ...(slide.contentMarkdown
        ? { contentMarkdown: slide.contentMarkdown }
        : {}),
      speakerTranscript: slide.speakerTranscript,
      ...(slide.backgroundExplanation
        ? { backgroundExplanation: slide.backgroundExplanation }
        : {}),
      sceneIntent: slide.sceneIntent,
      assetRefs: assetRefsForSlide({
        assetRefs,
        assetNeeds: slide.assetNeeds,
        sceneIntent: slide.sceneIntent,
      }),
    })),
    preview: {
      ...input.current.preview,
      slideCount: plannedSlides.length,
    },
    sourceDigest:
      input.request.sourceDigest?.trim() || requestBrief(input.request),
  });
}

function materializeAssets(payload: VideoPresentationProjectPayload) {
  const seen = new Map<string, VideoPresentationAsset>();
  for (const slide of payload.slides) {
    for (const assetRef of slide.assetRefs) {
      const existing = seen.get(assetRef.assetId);
      if (existing) {
        seen.set(assetRef.assetId, {
          ...existing,
          slideNumbers: [
            ...new Set([...existing.slideNumbers, slide.slideNumber]),
          ],
        });
        continue;
      }
      seen.set(assetRef.assetId, {
        assetId: assetRef.assetId,
        type: "editorial_illustration",
        prompt: `Provided or planned ${assetRef.role} asset for slide ${slide.slideNumber}: ${slide.sceneIntent}`,
        storageKey: `external:${safeStorageSegment(assetRef.assetId)}`,
        slideNumbers: [slide.slideNumber],
        source: "provided",
      });
    }
  }
  return [...seen.values()];
}

async function generateAudioTracks(input: {
  artifactId: string;
  deps: VideoPresentationWorkerDeps;
  payload: VideoPresentationProjectPayload;
  request: VideoPresentationCreateRequest;
  workspaceId: string;
}) {
  if (!requestNarrationEnabled(input.request)) {
    return [] satisfies VideoPresentationAudioTrack[];
  }

  const baseName = safeStorageSegment(input.payload.project.title);
  return Promise.all(
    input.payload.slides.map(async (slide) => {
      const transcript = slide.speakerTranscript.join(" ");
      let speech: Awaited<
        ReturnType<VideoPresentationWorkerDeps["tts"]["speech"]>
      >;
      try {
        speech = await input.deps.tts.speech({
          text: transcript,
          metadata: {
            artifactId: input.artifactId,
            feature: "video_presentation",
            slideNumber: slide.slideNumber,
            workspaceId: input.workspaceId,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown TTS generation error";
        throw new Error(
          `TTS generation failed for slide ${slide.slideNumber}: ${message}`,
        );
      }
      const mimeType = speech.mimeType || "audio/mpeg";
      const extension = extensionForMimeType(mimeType);
      const fileName = `${baseName}-slide-${slide.slideNumber}.${extension}`;
      const storageKey = input.deps.storage.buildArtifactStorageKey({
        artifactId: input.artifactId,
        fileName,
        workspaceId: input.workspaceId,
      });
      await input.deps.storage.upload({
        body: speech.audio,
        contentType: mimeType,
        key: storageKey,
      });
      return {
        slideNumber: slide.slideNumber,
        assetUrl: audioAssetUrl({
          artifactId: input.artifactId,
          fileName,
          workspaceId: input.workspaceId,
        }),
        storageBucket: input.deps.storage.getBucketName(),
        storageKey,
        durationSeconds: estimateNarrationDurationSeconds(transcript),
        mimeType,
        fileName,
      } satisfies VideoPresentationAudioTrack;
    }),
  );
}

async function assignSlideThemes(input: {
  deps: VideoPresentationWorkerDeps;
  payload: VideoPresentationProjectPayload;
}) {
  const outputSchema = themeAssignmentsOutputSchema(
    input.payload.slides.length,
  );
  let response: unknown;
  try {
    response = await input.deps.llm.completeStructured({
      temperature: 0.35,
      maxTokens: 1600,
      schema: z.toJSONSchema(outputSchema),
      schemaName: "video_presentation_theme_assignments",
      validate: (parsed) => {
        const check = outputSchema.safeParse(parsed);
        return check.success
          ? { ok: true }
          : {
              ok: false,
              feedback: summarizeStructuredValidationError({
                parsed,
                zodError: check.error,
                extra: `Assign every slide from 1 to ${input.payload.slides.length} exactly once.`,
              }),
            };
      },
      metadata: {
        feature: "video_presentation",
        stage: "assign_slide_themes",
      },
      messages: [
        {
          role: "system",
          content: [
            "You are a visual design director assigning color themes to a video presentation.",
            "Follow the supplied response schema and assign every slide exactly once.",
            "Maximize visual rhythm and avoid repeating the same theme on consecutive slides.",
            `Available themes:\n${THEME_DESCRIPTIONS}`,
          ].join("\n\n"),
        },
        {
          role: "user",
          content: input.payload.slides
            .map(
              (slide) =>
                `Slide ${slide.slideNumber}: ${slide.title}\nSubtitle: ${slide.subtitle ?? ""}\nMood: ${slide.backgroundExplanation ?? slide.sceneIntent}`,
            )
            .join("\n\n"),
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw videoPresentationProviderError(
      VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
      `Theme provider call failed: ${message}`,
    );
  }

  const parsed = outputSchema.safeParse(response);
  if (!parsed.success) {
    throw videoPresentationProviderError(
      VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
      "Theme provider returned invalid structured content.",
    );
  }

  const slideNumbers = new Set(
    input.payload.slides.map((slide) => slide.slideNumber),
  );
  const bySlide = new Map<number, VideoPresentationThemeAssignment>();
  for (const item of parsed.data.assignments) {
    const { slideNumber, themeName, mode } = item;
    if (!slideNumbers.has(slideNumber) || bySlide.has(slideNumber)) {
      throw videoPresentationProviderError(
        VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
        "Theme provider returned an invalid or duplicate slide assignment.",
      );
    }
    bySlide.set(slideNumber, {
      slideNumber,
      themeName,
      mode,
    });
  }

  if (bySlide.size !== input.payload.slides.length) {
    throw videoPresentationProviderError(
      VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
      "Theme provider did not assign every slide.",
    );
  }

  return input.payload.slides.map((slide) => bySlide.get(slide.slideNumber)!);
}

function sceneSystemPrompt() {
  return [
    "You are a senior motion designer and Remotion React engineer.",
    `Generate ONE self-contained React component exported as: export default function ${VIDEO_SCENE_COMPONENT_NAME}() { ... }`,
    "The code must be raw TSX/JSX only. Do not include markdown fences or explanations.",
    "Use only React and these Remotion globals/imports: AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig.",
    "Imports from 'react' and 'remotion' are allowed. Do not import any external dependency, CSS, font, data file, or package.",
    "Use inline styles only. No className, no DOM APIs, no fetch, no timers, no random values.",
    "Honor the requested canvas, brand, typography, pacing, and animation constraints. Keep all important text inside safe margins.",
    "Do NOT dump markdown on screen. Extract only 1-2 high-impact visual phrases, numbers, metaphors, or labels.",
    "Vary layout and motion per slide: cinematic opener, editorial spread, process map, comparison, kinetic type, diagram, quote, or recap as appropriate.",
    "Use the provided theme as inspiration, but do not force a fixed template.",
  ].join("\n");
}

function buildSceneUserPrompt(input: {
  audioTrack?: VideoPresentationAudioTrack;
  nextSlide?: VideoPresentationProjectPayload["slides"][number];
  payload: VideoPresentationProjectPayload;
  previousSlide?: VideoPresentationProjectPayload["slides"][number];
  slide: VideoPresentationProjectPayload["slides"][number];
  theme: VideoPresentationThemeAssignment;
}) {
  const durationSeconds =
    input.audioTrack?.durationSeconds ??
    durationTargetFallbackSeconds(input.payload.renderProfile.durationTarget);
  return [
    `Create slide ${input.slide.slideNumber} of ${input.payload.slides.length}.`,
    `Duration: ${durationSeconds.toFixed(1)} seconds at ${input.payload.project.fps}fps.`,
    `Canvas: ${input.payload.project.width}x${input.payload.project.height}.`,
    `Theme: ${input.theme.themeName} / ${input.theme.mode}.`,
    `Global visual direction: ${input.payload.project.globalVisualDirection}`,
    `Render profile: ${JSON.stringify(input.payload.renderProfile)}`,
    `Presentation title: ${input.payload.project.title}`,
    "",
    `Slide title: ${input.slide.title}`,
    `Subtitle: ${input.slide.subtitle ?? ""}`,
    `Scene intent: ${input.slide.sceneIntent}`,
    `Mood/background explanation: ${input.slide.backgroundExplanation ?? ""}`,
    `Content markdown for meaning only, not literal rendering:\n${input.slide.contentMarkdown ?? ""}`,
    `Narration:\n${input.slide.speakerTranscript.join(" ")}`,
    `Available asset refs:\n${JSON.stringify(input.slide.assetRefs, null, 2)}`,
    `Previous slide: ${input.previousSlide?.title ?? "none"}`,
    `Next slide: ${input.nextSlide?.title ?? "none"}`,
    "",
    "Return raw component code only.",
  ].join("\n");
}

function basicSceneCheck(code: string) {
  const diagnostics: string[] = [];
  const trimmed = code.trim();
  if (!trimmed) diagnostics.push("Empty scene code");
  if (trimmed.includes("```")) {
    diagnostics.push("Scene code still contains markdown fences");
  }
  const firstCodeToken = trimmed.match(
    /\b(import|export|function|const|let)\b/u,
  );
  if (
    firstCodeToken &&
    firstCodeToken.index !== undefined &&
    firstCodeToken.index > 0
  ) {
    diagnostics.push("Scene code contains prose before the first code token");
  }
  if (!trimmed.includes("export default")) {
    diagnostics.push(
      `Missing default export for ${VIDEO_SCENE_COMPONENT_NAME}`,
    );
  }
  if (!trimmed.includes(VIDEO_SCENE_COMPONENT_NAME)) {
    diagnostics.push(`Missing component name ${VIDEO_SCENE_COMPONENT_NAME}`);
  }
  if (!trimmed.includes("AbsoluteFill")) {
    diagnostics.push("Missing AbsoluteFill root layout");
  }
  if (!trimmed.includes("useCurrentFrame")) {
    diagnostics.push("Missing useCurrentFrame for motion timing");
  }
  for (const banned of [
    "fetch(",
    "document.",
    "window.",
    "setTimeout",
    "setInterval",
    "Math.random",
    "require(",
  ]) {
    if (trimmed.includes(banned))
      diagnostics.push(`Banned runtime usage: ${banned}`);
  }
  const invalidImport = [
    ...trimmed.matchAll(/import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/gu),
  ]
    .map((match) => match[1])
    .filter((source) => source !== "react" && source !== "remotion");
  for (const source of invalidImport) {
    diagnostics.push(`Unsupported import: ${source}`);
  }

  diagnostics.push(...typescriptSceneSyntaxDiagnostics(trimmed));

  const pairs: Array<[string, string, string]> = [
    ["{", "}", "brace"],
    ["(", ")", "parenthesis"],
    ["[", "]", "bracket"],
  ];
  for (const [open, close, name] of pairs) {
    let count = 0;
    for (const char of trimmed) {
      if (char === open) count += 1;
      if (char === close) count -= 1;
      if (count < 0) {
        diagnostics.push(`Unmatched closing ${name}`);
        break;
      }
    }
    if (count !== 0) diagnostics.push(`Unbalanced ${name}: ${count}`);
  }

  return diagnostics;
}

function typescriptSceneSyntaxDiagnostics(code: string) {
  const result = ts.transpileModule(normalizeSceneProjectCode(code), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "VideoScene.tsx",
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeSceneProjectCode(code: string) {
  const withoutAllowedImports = code
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["']react["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["']remotion["'];?\s*$/gm, "");
  return [
    'import React, { type CSSProperties } from "react";',
    'import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";',
    "",
    withoutAllowedImports.trim(),
  ].join("\n");
}

function buildProjectCodePayload(payload: VideoPresentationProjectPayload) {
  const sceneModules =
    payload.sceneModules.length > 0
      ? payload.sceneModules
      : [
          {
            slideNumber: 1,
            title: payload.project.title,
            code: [
              'import React from "react";',
              'import { AbsoluteFill } from "remotion";',
              "export default function VideoScene() {",
              `  return <AbsoluteFill style={{ background: "#101820", color: "white", padding: 96 }}>${JSON.stringify(payload.project.title)}</AbsoluteFill>;`,
              "}",
            ].join("\n"),
            componentName: VIDEO_SCENE_COMPONENT_NAME,
            durationInFrames: Math.max(1, Math.round(payload.project.fps * 5)),
            repairAttempts: 0,
            diagnostics: [],
            compileStatus: "compiled" as const,
          },
        ];
  const sceneFiles = sceneModules.map((scene) => ({
    path: `src/scenes/Slide${scene.slideNumber}.tsx`,
    content: [
      "// @ts-nocheck",
      `// Slide ${scene.slideNumber}: ${scene.title}`,
      normalizeSceneProjectCode(scene.code),
    ].join("\n"),
  }));
  const sceneImports = sceneModules
    .map(
      (scene) =>
        `import Slide${scene.slideNumber} from "./scenes/Slide${scene.slideNumber}";`,
    )
    .join("\n");
  const sceneEntries = sceneModules.map((scene) => ({
    slideNumber: scene.slideNumber,
    title: scene.title,
    durationInFrames: scene.durationInFrames,
    componentName: `Slide${scene.slideNumber}`,
  }));
  const totalDurationInFrames = sceneModules.reduce(
    (sum, scene) => sum + scene.durationInFrames,
    0,
  );
  return {
    entryFile: "src/index.ts",
    files: [
      ...sceneFiles,
      {
        path: "src/VideoScene.tsx",
        content: [
          'import React from "react";',
          'import { AbsoluteFill, Sequence } from "remotion";',
          sceneImports,
          "",
          "const sceneEntries = [",
          ...sceneEntries.map(
            (scene) =>
              `  { slideNumber: ${scene.slideNumber}, title: ${JSON.stringify(scene.title)}, durationInFrames: ${scene.durationInFrames}, Component: ${scene.componentName} },`,
          ),
          "] as const;",
          "",
          "export function getVideoDurationInFrames() {",
          `  return ${totalDurationInFrames};`,
          "}",
          "",
          "export default function VideoScene() {",
          "  let frameCursor = 0;",
          "  return (",
          '    <AbsoluteFill style={{ background: "#05070d" }}>',
          "      {sceneEntries.map((scene) => {",
          "        const from = frameCursor;",
          "        frameCursor += scene.durationInFrames;",
          "        const SceneComponent = scene.Component;",
          "        return (",
          "          <Sequence",
          "            durationInFrames={scene.durationInFrames}",
          "            from={from}",
          "            key={scene.slideNumber}",
          "          >",
          "            <SceneComponent />",
          "          </Sequence>",
          "        );",
          "      })}",
          "    </AbsoluteFill>",
          "  );",
          "}",
        ].join("\n"),
      },
      {
        path: "src/Root.tsx",
        content: [
          'import React from "react";',
          'import { Composition } from "remotion";',
          'import VideoScene, { getVideoDurationInFrames } from "./VideoScene";',
          "",
          "export default function RemotionRoot() {",
          "  return (",
          "    <Composition",
          '      id="video-presentation"',
          "      component={VideoScene}",
          "      durationInFrames={getVideoDurationInFrames()}",
          `      fps={${payload.project.fps}}`,
          `      width={${payload.project.width}}`,
          `      height={${payload.project.height}}`,
          "    />",
          "  );",
          "}",
        ].join("\n"),
      },
      {
        path: "src/index.ts",
        content: [
          'import { registerRoot } from "remotion";',
          'import RemotionRoot from "./Root";',
          "",
          "registerRoot(RemotionRoot);",
        ].join("\n"),
      },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            private: true,
            scripts: {
              build: "tsc -p tsconfig.json --noEmit",
              "render-smoke": "node scripts/render-smoke.mjs",
            },
            dependencies: {
              remotion: "^4.0.0",
              react: "^18.3.1",
              "react-dom": "^18.3.1",
            },
            devDependencies: {
              "@types/react": "^18.3.18",
              "@types/react-dom": "^18.3.5",
              typescript: "^5.9.2",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "tsconfig.json",
        content: JSON.stringify(
          {
            compilerOptions: {
              allowSyntheticDefaultImports: true,
              esModuleInterop: true,
              isolatedModules: true,
              jsx: "react-jsx",
              lib: ["DOM", "DOM.Iterable", "ES2022"],
              module: "ESNext",
              moduleResolution: "Bundler",
              noEmit: true,
              skipLibCheck: true,
              strict: true,
              target: "ES2022",
            },
            include: ["src/**/*.ts", "src/**/*.tsx"],
          },
          null,
          2,
        ),
      },
      {
        path: "video-presentation.manifest.json",
        content: JSON.stringify(
          {
            durationInFrames: totalDurationInFrames,
            fps: payload.project.fps,
            height: payload.project.height,
            scenes: sceneModules.map((scene) => ({
              durationInFrames: scene.durationInFrames,
              file: `src/scenes/Slide${scene.slideNumber}.tsx`,
              slideNumber: scene.slideNumber,
              title: scene.title,
            })),
            slideCount: sceneModules.length,
            title: payload.project.title,
            width: payload.project.width,
          },
          null,
          2,
        ),
      },
      {
        path: "scripts/render-smoke.mjs",
        content: [
          'import { existsSync, readFileSync } from "node:fs";',
          "",
          'const manifest = JSON.parse(readFileSync(new URL("../video-presentation.manifest.json", import.meta.url), "utf8"));',
          "if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {",
          '  throw new Error("manifest has no scenes");',
          "}",
          "for (const scene of manifest.scenes) {",
          "  if (!existsSync(new URL(`../${scene.file}`, import.meta.url))) {",
          "    throw new Error(`missing scene file: ${scene.file}`);",
          "  }",
          "  if (!Number.isInteger(scene.durationInFrames) || scene.durationInFrames <= 0) {",
          "    throw new Error(`invalid duration for slide ${scene.slideNumber}`);",
          "  }",
          "}",
          'console.log(JSON.stringify({ ok: true, stage: "render-smoke", slideCount: manifest.scenes.length, durationInFrames: manifest.durationInFrames }));',
        ].join("\n"),
      },
    ],
  };
}

async function runGeneratedProject(input: {
  deps: VideoPresentationWorkerDeps;
  job: VideoPresentationGenerateJobPayload;
  payload: VideoPresentationProjectPayload;
  request: VideoPresentationCreateRequest;
}) {
  const runProject = input.deps.sandbox?.runProject;
  if (!runProject) {
    throw videoPresentationSandboxError(
      VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE,
      "Video presentation generation requires a configured sandbox runtime.",
    );
  }

  try {
    return await runProject({
      job: input.job,
      payload: input.payload,
      request: input.request,
    });
  } catch (error) {
    if (isVideoPresentationSandboxError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw videoPresentationSandboxError(
      VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED,
      `Video presentation sandbox execution failed: ${message}`,
    );
  }
}

function videoPresentationSandboxError(code: string, message: string) {
  return new ContentError(503, code, `${code}: ${message}`, {
    recoverable: true,
  });
}

function videoPresentationProviderError(code: string, message: string) {
  return new ContentError(502, code, `${code}: ${message}`, {
    recoverable: true,
  });
}

function isVideoPresentationSandboxError(
  error: unknown,
): error is ContentError {
  return (
    error instanceof ContentError &&
    (error.code === VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE ||
      error.code === VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED)
  );
}

function createEmptySandboxFilesystemBackend() {
  return {
    async ls() {
      return { files: [] };
    },
    async read() {
      return {
        error:
          "No SourceWeft VFS is mounted for video project worker sandbox execution.",
      };
    },
    async readRaw() {
      return {
        error:
          "No SourceWeft VFS is mounted for video project worker sandbox execution.",
      };
    },
    async grep() {
      return { matches: [] };
    },
    async glob() {
      return { files: [] };
    },
    async write() {
      return {
        error:
          "No SourceWeft VFS is mounted for video project worker sandbox execution.",
      };
    },
    async edit() {
      return {
        error:
          "No SourceWeft VFS is mounted for video project worker sandbox execution.",
      };
    },
  };
}

async function runProjectInConfiguredSandbox(input: {
  job: VideoPresentationGenerateJobPayload;
  payload: VideoPresentationProjectPayload;
}) {
  try {
    const [sandboxServiceModule] = await Promise.all([
      import("../../modules/threads/agent/sandbox-service/service"),
    ]);
    const sandboxRuntime =
      sandboxServiceModule.agentSandboxService.createRuntimeForTurn({
        filesystem: createEmptySandboxFilesystemBackend() as never,
        context: {
          teamId: input.job.teamId,
          workspaceId: input.job.workspaceId,
          threadId: input.job.threadId,
          userId: input.job.userId,
          messageId: input.job.userMessageId,
          runId: input.job.traceId ?? input.job.jobId,
          sandboxExecuteToolCallId: input.job.toolCallId,
        },
      });
    if (!sandboxRuntime) {
      throw videoPresentationSandboxError(
        VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE,
        "The configured sandbox runtime is disabled or unavailable.",
      );
    }

    const projectCode = buildProjectCodePayload(input.payload);
    const root = `${sandboxRuntime.pathPolicy.defaultCwd.replace(/\/$/u, "")}/video-presentation-${safeStorageSegment(input.job.artifactId)}`;
    const files = projectCode.files.map(
      (file) =>
        [`${root}/${file.path}`, new TextEncoder().encode(file.content)] as [
          string,
          Uint8Array,
        ],
    );
    const uploads = await sandboxRuntime.backend.uploadFiles(files);
    const uploadError = uploads.find((upload) => upload.error);
    if (uploadError) {
      return {
        install: {
          ok: false,
          diagnostics: [
            `Failed to upload ${uploadError.path}: ${uploadError.error}`,
          ],
          stderr: String(uploadError.error),
        },
        typecheck: { ok: false, diagnostics: [] },
        smoke: { ok: false, diagnostics: [] },
      };
    }

    const run = async (command: string) =>
      projectExecutionResultFromSandbox(
        await sandboxRuntime.backend.execute(
          `cd ${shellQuote(root)} && ${command}`,
          {
            toolCallId: `${input.job.toolCallId ?? input.job.jobId}:${safeStorageSegment(command).slice(0, 40)}`,
          },
        ),
      );
    const install = await run("pnpm install");
    const typecheck = install.ok
      ? await run("pnpm run build")
      : { ok: false, diagnostics: [] };
    const smoke =
      install.ok && typecheck.ok
        ? await run("pnpm run render-smoke")
        : { ok: false, diagnostics: [] };
    return { install, typecheck, smoke };
  } catch (error) {
    logger.warn("Video presentation sandbox execution failed", {
      error: error instanceof Error ? error.message : String(error),
      artifactId: input.job.artifactId,
      jobId: input.job.jobId,
    });
    throw error;
  }
}

async function repairSceneModule(input: {
  deps: VideoPresentationWorkerDeps;
  diagnostics: string[];
  sceneCode: string;
  slide: VideoPresentationProjectPayload["slides"][number];
}) {
  let code = input.sceneCode;
  let diagnostics = input.diagnostics;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const response = await input.deps.llm.complete({
      temperature: 0.15,
      maxTokens: 5000,
      metadata: {
        feature: "video_presentation",
        slideNumber: input.slide.slideNumber,
        stage: "repair_scene_module",
      },
      messages: [
        {
          role: "system",
          content: [
            "You repair Remotion React scene code.",
            "Return only the fixed raw component code. No markdown fences, no explanation.",
            `The component must export default function ${VIDEO_SCENE_COMPONENT_NAME}().`,
            "Preserve the visual intent, but fix syntax, missing exports, unsupported imports, and invalid runtime usage.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Slide ${input.slide.slideNumber}: ${input.slide.title}`,
            `Diagnostics:\n${diagnostics.join("\n")}`,
            `Broken code:\n${code}`,
          ].join("\n\n"),
        },
      ],
    });
    code = extractSceneCodeAndTitle(response).code;
    diagnostics = basicSceneCheck(code);
    if (diagnostics.length === 0) {
      return { code, diagnostics: [], repairAttempts: attempt };
    }
  }

  return { code, diagnostics, repairAttempts: MAX_REPAIR_ATTEMPTS };
}

async function generateSceneModules(input: {
  deps: VideoPresentationWorkerDeps;
  payload: VideoPresentationProjectPayload;
}) {
  const themeBySlide = new Map(
    input.payload.themeAssignments.map((theme) => [theme.slideNumber, theme]),
  );
  const audioBySlide = new Map(
    input.payload.audioTracks.map((track) => [track.slideNumber, track]),
  );

  return Promise.all(
    input.payload.slides.map(async (slide, index) => {
      const theme = themeBySlide.get(slide.slideNumber);
      if (!theme) {
        throw videoPresentationProviderError(
          VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
          `No provider-generated theme assignment exists for slide ${slide.slideNumber}.`,
        );
      }
      const response = await input.deps.llm.complete({
        temperature: 0.72,
        maxTokens: 6000,
        metadata: {
          feature: "video_presentation",
          slideNumber: slide.slideNumber,
          stage: "generate_scene_module",
        },
        messages: [
          { role: "system", content: sceneSystemPrompt() },
          {
            role: "user",
            content: buildSceneUserPrompt({
              audioTrack: audioBySlide.get(slide.slideNumber),
              nextSlide: input.payload.slides[index + 1],
              payload: input.payload,
              previousSlide: input.payload.slides[index - 1],
              slide,
              theme,
            }),
          },
        ],
      });
      const { code, title } = extractSceneCodeAndTitle(response);
      const diagnostics = basicSceneCheck(code);
      const durationSeconds =
        audioBySlide.get(slide.slideNumber)?.durationSeconds ??
        durationTargetFallbackSeconds(
          input.payload.renderProfile.durationTarget,
        );
      return {
        slideNumber: slide.slideNumber,
        title: title || slide.title,
        code,
        componentName: VIDEO_SCENE_COMPONENT_NAME,
        durationInFrames: Math.max(
          60,
          Math.ceil(durationSeconds * input.payload.project.fps),
        ),
        compileStatus: diagnostics.length > 0 ? "failed" : "compiled",
        diagnostics,
        repairAttempts: 0,
      } satisfies VideoPresentationSceneModule;
    }),
  );
}

async function repairSceneModules(input: {
  deps: VideoPresentationWorkerDeps;
  payload: VideoPresentationProjectPayload;
}) {
  const bySlide = new Map(
    input.payload.slides.map((slide) => [slide.slideNumber, slide]),
  );
  return Promise.all(
    input.payload.sceneModules.map(async (scene) => {
      if (scene.diagnostics.length === 0 && scene.compileStatus !== "failed") {
        return scene;
      }
      const slide = bySlide.get(scene.slideNumber);
      if (!slide) return scene;
      const repaired = await repairSceneModule({
        deps: input.deps,
        diagnostics: scene.diagnostics,
        sceneCode: scene.code,
        slide,
      });
      return {
        ...scene,
        code: repaired.code,
        diagnostics: repaired.diagnostics,
        repairAttempts: repaired.repairAttempts,
        compileStatus:
          repaired.diagnostics.length === 0 ? "repaired" : "failed",
      } satisfies VideoPresentationSceneModule;
    }),
  );
}

function updatePayloadStage(
  payload: VideoPresentationProjectPayload,
  stage: Stage,
  status: VideoPresentationProjectPayload["generation"]["status"] = "running",
  execution?: { attempt: number; maxAttempts: number; retrying?: boolean },
) {
  return videoPresentationProjectPayloadSchema.parse({
    ...payload,
    generation: {
      ...payload.generation,
      status,
      stage,
      progress: stageProgress(stage),
      ...(execution
        ? {
            attempt: execution.attempt,
            maxAttempts: execution.maxAttempts,
            retrying: execution.retrying ?? false,
          }
        : {}),
      ...(stage === "failed"
        ? {}
        : { errorCode: undefined, errorMessage: undefined }),
    },
  });
}

function resolveWorkerThinking(input: {
  llm?: LlmExecutionConfig;
  profileConfig?: Record<string, unknown>;
}): ThinkingConfig {
  const supportedParameters = Array.isArray(
    input.profileConfig?.supportedParameters,
  )
    ? input.profileConfig.supportedParameters.filter(
        (value): value is string => typeof value === "string",
      )
    : input.llm?.thinking?.supportedParameters;
  const supportedEfforts = Array.isArray(input.profileConfig?.supportedEfforts)
    ? input.profileConfig.supportedEfforts.filter(
        (
          value,
        ): value is NonNullable<ThinkingConfig["supportedEfforts"]>[number] =>
          value === "minimal" ||
          value === "low" ||
          value === "medium" ||
          value === "high" ||
          value === "xhigh",
      )
    : input.llm?.thinking?.supportedEfforts;

  return {
    ...input.llm?.thinking,
    mode: input.llm?.thinking?.mode ?? "off",
    enabled: input.llm?.thinking?.enabled ?? false,
    includeReasoning: input.llm?.thinking?.includeReasoning ?? false,
    ...(supportedParameters ? { supportedParameters } : {}),
    ...(supportedEfforts ? { supportedEfforts } : {}),
  };
}

async function createDefaultDeps(
  job?: VideoPresentationGenerateJobPayload,
): Promise<VideoPresentationWorkerDeps> {
  const [repository, storage, modelGateway] = await Promise.all([
    import("../../modules/artifacts/repository"),
    import("../../modules/sources/storage"),
    import("../../shared/model-gateway"),
  ]);
  let modelDeps: Promise<{
    chatGateway: ModelGateway;
    chatProfile: NonNullable<
      Awaited<ReturnType<typeof modelGateway.resolveModelGatewayProfile>>
    >;
    ttsGateway: ModelGateway;
    ttsProfile: Awaited<
      ReturnType<typeof modelGateway.requireDefaultModelGatewayProfile>
    >;
  }> | null = null;
  const resolveModelDeps = () => {
    modelDeps ??= (async () => {
      const [chatProfile, ttsProfile] = await Promise.all([
        modelGateway.resolveModelGatewayProfile({
          kind: "chat",
          requestedProfileAlias:
            job?.llm?.executionMode === "BYOK"
              ? undefined
              : job?.llm?.profileAlias,
          requestedModelAlias:
            job?.llm?.executionMode === "BYOK"
              ? undefined
              : job?.llm?.modelAlias,
          defaultRequired: true,
        }),
        modelGateway.requireDefaultModelGatewayProfile("tts"),
      ]);
      if (!chatProfile) {
        throw new Error("Default chat model gateway profile is not configured");
      }
      const [chatGateway, ttsGateway] = await Promise.all([
        modelGateway.getModelGatewayClient(chatProfile.gatewayConfigId),
        modelGateway.getModelGatewayClient(ttsProfile.gatewayConfigId),
      ]);
      return { chatGateway, chatProfile, ttsGateway, ttsProfile };
    })();
    return modelDeps;
  };

  const buildChatCall = async (
    input: WorkerLlmInput,
    structuredOutput?: ChatCompleteInput["structuredOutput"],
  ) => {
    const { chatGateway, chatProfile } = await resolveModelDeps();
    const isByok = job?.llm?.executionMode === "BYOK";
    const thinking = resolveWorkerThinking({
      llm: job?.llm,
      profileConfig: chatProfile.configJson,
    });
    const stage =
      typeof input.metadata.stage === "string"
        ? input.metadata.stage
        : "generate";
    const operation = `video_presentation.${stage}`;
    const auditMetadata = job
      ? buildGatewayRequestMetadata({
          teamId: job.teamId,
          workspaceId: job.workspaceId,
          userId: job.userId,
          threadId: job.threadId,
          messageId: job.userMessageId,
          feature: "video_presentation",
          operation,
          modelKind: "chat",
          modelAlias: chatProfile.modelAlias,
          profileAlias: isByok ? null : chatProfile.profileAlias,
          llm: job.llm,
          parentSpanId: job.parentSpanId,
        })
      : { feature: "video_presentation", operation };
    const request: ChatCompleteInput = {
      model: isByok
        ? (job?.llm?.providerModel ??
          job?.llm?.modelAlias ??
          chatProfile.modelAlias)
        : chatProfile.modelAlias,
      messages: input.messages,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      metadata: {
        ...input.metadata,
        ...(job
          ? {
              teamId: job.teamId,
              workspaceId: job.workspaceId,
              userId: job.userId,
              threadId: job.threadId,
              messageId: job.userMessageId,
            }
          : {}),
        profileAlias: isByok ? null : chatProfile.profileAlias,
        modelAlias: isByok
          ? (job?.llm?.modelAlias ?? job?.llm?.providerModel ?? null)
          : chatProfile.modelAlias,
        providerModel: job?.llm?.providerModel ?? chatProfile.modelAlias,
        thinkingMode: thinking.mode,
      },
      ...(structuredOutput ? { structuredOutput } : {}),
      ...(isByok
        ? {
            executionMode: "BYOK" as const,
            providerHint: job?.llm?.providerHint,
            byokModelId: job?.llm?.byokModelId,
            credentialId: job?.llm?.credentialId,
            byok: job?.llm?.byok,
          }
        : {
            executionMode: "GLOBAL" as const,
            profileAlias: chatProfile.profileAlias,
          }),
      thinking,
    };
    return {
      chatGateway,
      request,
      options: {
        ...(job ? { traceId: job.traceId ?? job.jobId } : {}),
        metadata: auditMetadata,
      },
    };
  };

  return {
    artifacts: {
      find: repository.findArtifactRecord,
      markFailed: repository.markArtifactFailed,
      markReady: repository.markArtifactReady,
      markRunning: repository.markArtifactRunning,
    },
    llm: {
      complete: async (input) => {
        const { chatGateway, request, options } = await buildChatCall(input);
        for (let attempt = 0; attempt <= MAX_LLM_EMPTY_RETRIES; attempt += 1) {
          const result = await chatGateway.chat.complete(
            {
              ...request,
              metadata: {
                ...request.metadata,
                attempt,
              },
            },
            {
              ...options,
              metadata: { ...options.metadata, attempt },
            },
          );
          const content = extractTextContent(result.raw.content);
          if (content.trim()) {
            return content;
          }
        }
        throw new Error(
          "Video presentation LLM returned empty content after 3 successful responses",
        );
      },
      completeStructured: async (input) => {
        // Declare only the schema and let LangChain pick the structured-output
        // method per model (json_schema for deepseek). The worker must not pin
        // a method here.
        const structuredOutput = {
          name: input.schemaName,
          schema: input.schema,
        };
        const runOnce = async (messages: WorkerChatMessage[]) => {
          const { chatGateway, request, options } = await buildChatCall(
            { ...input, messages },
            structuredOutput,
          );
          const result = await chatGateway.chat.complete(request, options);
          if (!result.structuredOutput) {
            throw new Error(
              "Video presentation LLM returned no parsed structured output",
            );
          }
          return result.structuredOutput;
        };

        const first = await runOnce(input.messages);
        if (!input.validate) {
          return first;
        }
        const verdict = input.validate(first);
        if (verdict.ok) {
          return first;
        }
        // One repair attempt on the same model/method, showing the model its
        // previous output and the validation feedback.
        const repaired = await runOnce([
          ...input.messages,
          { role: "assistant", content: JSON.stringify(first) },
          {
            role: "user",
            content: [
              "The previous response failed validation and was rejected.",
              verdict.feedback,
              "Return a corrected response that satisfies the schema and these constraints. Output only the structured result.",
            ].join("\n\n"),
          },
        ]);
        return repaired;
      },
    },
    sandbox: {
      runProject: (input) =>
        runProjectInConfiguredSandbox({
          job: input.job,
          payload: input.payload,
        }),
    },
    storage: {
      buildArtifactStorageKey: storage.buildArtifactStorageKey,
      getBucketName: storage.getContentStorageBucketName,
      upload: async (input) => {
        await storage.uploadArtifactObject(input);
      },
    },
    tts: {
      speech: async (input) => {
        const { ttsGateway, ttsProfile } = await resolveModelDeps();
        const request: TtsSpeechInput = {
          model: ttsProfile.modelAlias,
          input: input.text,
          responseFormat: "mp3",
          metadata: input.metadata,
        };
        const result = await (ttsGateway as ModelGateway).tts.speech(request);
        return {
          audio: Buffer.from(result.audio),
          mimeType: result.mimeType || "audio/mpeg",
        };
      },
    },
  };
}

export function createVideoPresentationGenerateProcessor(
  resolveDeps: (
    job?: VideoPresentationGenerateJobPayload,
  ) => Promise<VideoPresentationWorkerDeps>,
) {
  return async function processVideoPresentationGenerateJobWithDeps(
    job: Job<Record<string, unknown>>,
  ) {
    const payload = job.data as VideoPresentationGenerateJobPayload;
    const deps = await resolveDeps(payload);
    const request = videoPresentationCreateRequestSchema.parse(payload.request);
    const artifact = await deps.artifacts.find({
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
      artifactId: payload.artifactId,
    });

    if (!artifact) {
      throw new Error(
        `Artifact not found for video presentation job ${payload.jobId}`,
      );
    }

    let projectPayload = videoPresentationProjectPayloadSchema.parse(
      artifact.payloadJson,
    );

    const pushRunning = async (stage: Stage) => {
      projectPayload = updatePayloadStage(projectPayload, stage, "running", {
        attempt: resolveJobAttempt(job),
        maxAttempts: resolveJobMaxAttempts(job),
      });
      await deps.artifacts.markRunning({
        artifactId: payload.artifactId,
        teamId: payload.teamId,
        workspaceId: payload.workspaceId,
        expectedStatuses: ["pending", "running"],
        payload: projectPayload,
      });
      await updateVideoPresentationJobProgress(job, projectPayload.generation);
    };

    try {
      await pushRunning("generating_project_code");
      await pushRunning("planning_storyboard");
      projectPayload = await planVideoProject({
        current: projectPayload,
        deps,
        request,
      });

      await pushRunning("materializing_assets");
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        assets: materializeAssets(projectPayload),
      });

      await pushRunning("generating_audio_tracks");
      const audioPromise = generateAudioTracks({
        artifactId: payload.artifactId,
        deps,
        payload: projectPayload,
        request,
        workspaceId: payload.workspaceId,
      });

      const themePromise = (async () => {
        await pushRunning("assigning_slide_themes");
        return assignSlideThemes({ deps, payload: projectPayload });
      })();

      const [audioTracks, themeAssignments] = await Promise.all([
        audioPromise,
        themePromise,
      ]);
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        audioTracks,
        themeAssignments,
      });

      await pushRunning("generating_scene_modules");
      const sceneModules = await generateSceneModules({
        deps,
        payload: projectPayload,
      });
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        sceneModules,
      });

      await pushRunning("repairing_scene_modules");
      const repairedSceneModules = await repairSceneModules({
        deps,
        payload: projectPayload,
      });
      const failedScenes = repairedSceneModules.filter(
        (scene) =>
          scene.compileStatus === "failed" || scene.diagnostics.length > 0,
      );
      if (failedScenes.length > 0) {
        const first = failedScenes[0]!;
        throw new Error(
          `Scene ${first.slideNumber} failed validation after repair: ${first.diagnostics.join("; ")}`,
        );
      }
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        sceneModules: repairedSceneModules,
      });

      await pushRunning("installing_project");
      const projectRun = normalizeProjectExecutionResults(
        await runGeneratedProject({
          deps,
          job: payload,
          payload: projectPayload,
          request,
        }),
      );
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        projectCode: {
          ...buildProjectCodePayload(projectPayload),
          install: projectRun.install,
          typecheck: {
            ok: false,
            diagnostics: [],
          },
          smoke: {
            checked: false,
            ok: false,
            diagnostics: [],
          },
        },
      });
      if (!projectRun.install.ok) {
        throw new Error(
          `Generated Remotion project dependency install failed: ${projectRun.install.diagnostics.join("; ") || projectRun.install.stderr || "unknown install failure"}`,
        );
      }

      await pushRunning("typechecking_project");
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        projectCode: {
          ...projectPayload.projectCode,
          ...buildProjectCodePayload(projectPayload),
          install: projectRun.install,
          typecheck: projectRun.typecheck,
          smoke: {
            checked: false,
            ok: false,
            diagnostics: [],
          },
        },
      });
      if (!projectRun.typecheck.ok) {
        throw new Error(
          `Generated Remotion project failed typecheck: ${projectRun.typecheck.diagnostics.join("; ") || projectRun.typecheck.stderr || "unknown typecheck failure"}`,
        );
      }

      await pushRunning("rendering_smoke_preview");
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        projectCode: {
          ...buildProjectCodePayload(projectPayload),
          install: projectRun.install,
          typecheck: projectRun.typecheck,
          smoke: {
            checked: true,
            ...projectRun.smoke,
          },
        },
      });
      if (!projectRun.smoke.ok) {
        throw new Error(
          `Generated Remotion project failed render smoke check: ${projectRun.smoke.diagnostics.join("; ") || projectRun.smoke.stderr || "unknown smoke failure"}`,
        );
      }

      await pushRunning("publishing_video_project");
      const durationInFrames = projectPayload.sceneModules.reduce(
        (sum, scene) => sum + scene.durationInFrames,
        0,
      );
      const durationSeconds = Number(
        (durationInFrames / projectPayload.project.fps).toFixed(2),
      );
      projectPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        generation: {
          ...projectPayload.generation,
          status: "ready",
          stage: "ready",
          progress: 100,
        },
        project: {
          ...projectPayload.project,
          durationSeconds,
        },
        preview: {
          ...projectPayload.preview,
          slideCount: projectPayload.slides.length,
          durationSeconds,
        },
      });

      const readyPayload = attachReadySourceJson({
        artifactId: payload.artifactId,
        jobId: payload.jobId,
        payload: projectPayload,
        workspaceId: payload.workspaceId,
      });

      const result = await deps.artifacts.markReady({
        artifactId: payload.artifactId,
        teamId: payload.teamId,
        workspaceId: payload.workspaceId,
        userId: payload.userId,
        payload: readyPayload,
      });

      logger.info("Video presentation project published", {
        artifactId: payload.artifactId,
        jobId: payload.jobId,
        versionId: result.versionId,
      });

      return {
        artifactId: payload.artifactId,
        status: "ready",
        versionId: result.versionId,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown video presentation error";
      const safeErrorMessage = truncateText(
        errorMessage,
        MAX_ERROR_MESSAGE_LENGTH,
      );
      const errorCode =
        error instanceof ContentError
          ? error.code
          : "VIDEO_PRESENTATION_GENERATION_FAILED";
      const attempt = resolveJobAttempt(job);
      const maxAttempts = resolveJobMaxAttempts(job);
      if (!isFinalJobAttempt(job)) {
        projectPayload = videoPresentationProjectPayloadSchema.parse({
          ...projectPayload,
          generation: {
            ...projectPayload.generation,
            status: "running",
            attempt,
            maxAttempts,
            retrying: true,
            errorCode: undefined,
            errorMessage: undefined,
          },
        });
        await deps.artifacts.markRunning({
          artifactId: payload.artifactId,
          teamId: payload.teamId,
          workspaceId: payload.workspaceId,
          expectedStatuses: ["pending", "running"],
          payload: projectPayload,
        });
        await updateVideoPresentationJobProgress(
          job,
          projectPayload.generation,
        );
        logger.warn("Video presentation generation attempt will be retried", {
          artifactId: payload.artifactId,
          attempt,
          error: safeErrorMessage,
          jobId: payload.jobId,
          maxAttempts,
        });
        throw error;
      }
      const failedPayload = videoPresentationProjectPayloadSchema.parse({
        ...projectPayload,
        generation: {
          ...projectPayload.generation,
          status: "failed",
          stage: "failed",
          progress: 100,
          attempt,
          maxAttempts,
          retrying: false,
          errorCode,
          errorMessage: safeErrorMessage,
        },
      });
      await deps.artifacts.markFailed({
        artifactId: payload.artifactId,
        teamId: payload.teamId,
        workspaceId: payload.workspaceId,
        expectedStatuses: ["pending", "running"],
        errorCode,
        errorMessage: safeErrorMessage,
        payload: failedPayload,
      });
      await updateVideoPresentationJobProgress(job, failedPayload.generation);
      throw error;
    }
  };
}

export const processVideoPresentationGenerateJob =
  createVideoPresentationGenerateProcessor(createDefaultDeps);

export const testExports = {
  basicSceneCheck,
  buildSceneUserPrompt,
  extractSceneCodeAndTitle,
  planVideoProject,
};
