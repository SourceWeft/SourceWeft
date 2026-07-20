import { z } from "zod";
import {
  videoPresentationProjectPayloadSchema,
  VIDEO_PRESENTATION_ERROR_CODES,
  type VideoPresentationAsset,
  type VideoPresentationAssetRef,
  type VideoPresentationCreateRequest,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import type { VideoPipelineDeps } from "./deps";
import { videoPresentationProviderError } from "./errors";
import { artifactAssetUrl, imageExtensionForMimeType, safeStorageSegment } from "./util";

const {
  storyboardGenerationFailed: VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED,
} = VIDEO_PRESENTATION_ERROR_CODES;

// Word-count fallback only. Whenever a real audio track exists its measured
// duration (probeAudioDurationSeconds) is authoritative — never use this
// estimate in that case.
export function estimateNarrationDurationSeconds(text: string) {
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

export function durationTargetFallbackSeconds(
  target: VideoPresentationProjectPayload["renderProfile"]["durationTarget"],
) {
  if (target === "short") return 6;
  if (target === "long") return 14;
  return 10;
}

export function assetRefsForSlide(input: {
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

export type PlannedSlide = {
  slideNumber: number;
  title: string;
  subtitle?: string;
  contentMarkdown?: string;
  speakerTranscript: string[];
  backgroundExplanation?: string;
  sceneIntent: string;
  assetNeeds: string[];
};

// Per-slide density budget: slides carry one idea each, on-screen text stays a
// distillation, and narration length keeps TTS pacing near the duration target.
export function storyboardSlideSchema(maxSlideNumber: number) {
  return z
    .object({
      slideNumber: z.number().int().min(1).max(maxSlideNumber),
      title: z.string().trim().min(1).max(60),
      subtitle: z.string().trim().min(1).max(90).nullable(),
      contentMarkdown: z.string().trim().min(1).max(400).nullable(),
      speakerTranscript: z
        .array(z.string().trim().min(1).max(220))
        .min(1)
        .max(4),
      backgroundExplanation: z.string().trim().min(1).max(1000).nullable(),
      sceneIntent: z.string().trim().min(1).max(300),
      assetNeeds: z.array(z.string().trim().min(1)).max(4),
    })
    .strict();
}

export function storyboardOutputSchema(slideCount: number) {
  return z
    .object({
      slides: z.array(storyboardSlideSchema(slideCount)).length(slideCount),
      globalVisualDirection: z.string().trim().min(20).max(600),
    })
    .strict();
}

// Acceptable estimated narration seconds per slide for a duration target. The
// ranges account for estimateNarrationDurationSeconds' +1.25s lead-in and 4s
// floor, so the CJK-aware estimator can be used directly for validation.
export function narrationBudgetSecondsPerSlide(
  target: VideoPresentationProjectPayload["renderProfile"]["durationTarget"],
) {
  if (target === "short") return { min: 4, max: 9 };
  if (target === "long") return { min: 8, max: 19 };
  return { min: 5, max: 14 };
}

export function narrationBudgetIssues(input: {
  slides: Array<{ slideNumber: number; speakerTranscript: string[] }>;
  target: VideoPresentationProjectPayload["renderProfile"]["durationTarget"];
}) {
  const budget = narrationBudgetSecondsPerSlide(input.target);
  const asWords = (seconds: number) => Math.round((seconds - 1.25) * 2.45);
  const asCjkChars = (seconds: number) => Math.round((seconds - 1.25) * 5.2);
  return input.slides.flatMap((slide) => {
    const estimated = estimateNarrationDurationSeconds(
      slide.speakerTranscript.join(" "),
    );
    if (estimated >= budget.min && estimated <= budget.max) {
      return [];
    }
    const direction = estimated > budget.max ? "too long" : "too short";
    return [
      `Slide ${slide.slideNumber} narration is ${direction}: ~${estimated.toFixed(1)}s spoken, target ${budget.min}-${budget.max}s. Aim for ${asWords(budget.min)}-${asWords(budget.max)} words (or ${asCjkChars(budget.min)}-${asCjkChars(budget.max)} Chinese characters).`,
    ];
  });
}

export function requestRenderProfile(request: VideoPresentationCreateRequest) {
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

export function requestSlideCount(request: VideoPresentationCreateRequest) {
  const target = request.slideCount;
  if (typeof target === "number" && Number.isInteger(target)) {
    return Math.min(12, Math.max(1, target));
  }
  const durationTarget = requestRenderProfile(request).durationTarget;
  if (durationTarget === "short") return 4;
  if (durationTarget === "long") return 8;
  return 6;
}

export function requestCanvas(request: VideoPresentationCreateRequest) {
  return {
    width: request.canvas?.width ?? 1920,
    height: request.canvas?.height ?? 1080,
    fps: request.canvas?.fps ?? 30,
  };
}

export function formatCustomizationForPrompt(
  request: VideoPresentationCreateRequest,
) {
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

export function requestNarrationEnabled(
  request: VideoPresentationCreateRequest,
) {
  return request.narration?.enabled ?? request.narrationEnabled ?? true;
}

export function requestBrief(request: VideoPresentationCreateRequest) {
  return (
    request.brief?.trim() ||
    request.sourceDigest?.trim() ||
    request.title?.trim() ||
    "Create a concise video presentation."
  );
}

export function normalizePlannedSlides(
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

export function summarizeStructuredValidationError(input: {
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

export async function planStoryboard(input: {
  deps: VideoPipelineDeps;
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
        const budgetIssues = narrationBudgetIssues({
          slides: check.data.slides,
          target: renderProfile.durationTarget,
        });
        if (budgetIssues.length > 0) {
          return {
            ok: false,
            feedback: summarizeStructuredValidationError({
              parsed,
              extra: `Narration pacing is off budget:\n${budgetIssues.join("\n")}`,
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
            "Also produce globalVisualDirection: a concrete, specific art direction for the whole video (imagery, palette mood, typography feel, motion character) tailored to the topic and the requested style preset — 1-3 sentences, no generic phrases like 'professional and modern'.",
            "Every slide must use its one-based slideNumber exactly once.",
            "Use null for optional text fields when they are not needed.",
            "Keep narration natural for spoken audio. Do not include code.",
            "Density budget (hard limits): one core idea per slide; title <= 60 chars; subtitle <= 90 chars; contentMarkdown is a distillation of at most ~5 short lines (<= 400 chars total), never a paragraph dump.",
            `Narration pacing: each slide's spoken narration must take ${narrationBudgetSecondsPerSlide(renderProfile.durationTarget).min}-${narrationBudgetSecondsPerSlide(renderProfile.durationTarget).max} seconds when read aloud (~2.45 words/sec in English, ~5.2 chars/sec in Chinese). Split oversized ideas across slides instead of cramming.`,
            renderProfile.visualDensity === "light"
              ? "Visual density is light: keep on-screen text minimal (1-2 short phrases per slide)."
              : renderProfile.visualDensity === "dense"
                ? "Visual density is dense: slides may carry more supporting points, but stay within the hard limits."
                : "Visual density is balanced: 2-4 short supporting points per slide at most.",
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
  if (!parsed.success || !slides) {
    throw videoPresentationProviderError(
      VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED,
      `Storyboard provider returned invalid structured content; expected exactly one complete entry for slides 1-${slideCount}.`,
    );
  }
  return { slides, globalVisualDirection: parsed.data.globalVisualDirection };
}

export async function planVideoProject(input: {
  current: VideoPresentationProjectPayload;
  deps: VideoPipelineDeps;
  request: VideoPresentationCreateRequest;
}) {
  const planned = await planStoryboard({
    deps: input.deps,
    request: input.request,
  });
  const plannedSlides = planned.slides;
  const renderProfile = requestRenderProfile(input.request);
  const title =
    input.request.title?.trim() ||
    plannedSlides[0]?.title ||
    input.current.project.title;
  const canvas = requestCanvas(input.request);
  const globalVisualDirection =
    input.request.visualDirection?.trim() ||
    planned.globalVisualDirection ||
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
      ...(input.request.brand ? { brand: input.request.brand } : {}),
      ...(input.request.motion ? { motion: input.request.motion } : {}),
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
      assetNeeds: slide.assetNeeds,
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

export function collectPlannedAssets(payload: VideoPresentationProjectPayload) {
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

/**
 * Materialize provided assets into real files: fetch each referenced image
 * (e.g. an image artifact the user generated earlier), copy it into THIS
 * artifact's asset namespace and record the served URL. Scenes may then
 * display it via <AssetImage src>. Unresolvable assets keep their external
 * placeholder (and scenes get no URL for them).
 */
const MAX_GENERATED_ASSETS = 4;

const GENERATABLE_ASSET_TYPES = new Set([
  "hero",
  "editorial_illustration",
  "scene_background",
  "abstract_texture",
  "diagrammatic_visual",
]);

async function storeAssetBytes(input: {
  artifactId: string;
  assetId: string;
  data: Uint8Array;
  deps: VideoPipelineDeps;
  mimeType: string;
  workspaceId: string;
}) {
  const fileName = `asset-${safeStorageSegment(input.assetId)}${imageExtensionForMimeType(input.mimeType)}`;
  const storageKey = input.deps.storage.buildArtifactStorageKey({
    artifactId: input.artifactId,
    fileName,
    workspaceId: input.workspaceId,
  });
  await input.deps.storage.upload({
    body: input.data,
    contentType: input.mimeType,
    key: storageKey,
  });
  return {
    storageKey,
    storageBucket: input.deps.storage.getBucketName(),
    sourceUrl: artifactAssetUrl({
      artifactId: input.artifactId,
      fileName,
      workspaceId: input.workspaceId,
    }),
  };
}

export async function materializeAssets(input: {
  artifactId: string;
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
  workspaceId: string;
}): Promise<{
  assets: VideoPresentationAsset[];
  slides: VideoPresentationProjectPayload["slides"];
}> {
  const planned = collectPlannedAssets(input.payload);
  const provided = await Promise.all(
    planned.map(async (asset) => {
      // Re-materialized on edit runs too: cheap, and keeps URLs stable.
      const fetched = await input.deps.assets
        .fetchImage({ assetId: asset.assetId })
        .catch((error) => {
          input.deps.logger.warn("video_presentation_asset_fetch_failed", {
            artifactId: input.artifactId,
            assetId: asset.assetId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      if (!fetched) {
        return asset;
      }
      const stored = await storeAssetBytes({
        artifactId: input.artifactId,
        assetId: asset.assetId,
        data: fetched.data,
        deps: input.deps,
        mimeType: fetched.mimeType,
        workspaceId: input.workspaceId,
      });
      return { ...asset, ...stored };
    }),
  );

  // Generated imagery: fill uncovered assetNeeds via the image model (capped;
  // silently skipped when no image capability is configured). Slides gain an
  // assetRef so scenes can reference the generated asset by URL.
  const generatedAssets: VideoPresentationAsset[] = [];
  const extraRefsBySlide = new Map<
    number,
    Array<{ assetId: string; role: string }>
  >();
  if (input.deps.image) {
    for (const slide of input.payload.slides) {
      if (generatedAssets.length >= MAX_GENERATED_ASSETS) {
        break;
      }
      const coveredRoles = new Set(
        slide.assetRefs.map((assetRef) => assetRef.role),
      );
      for (const need of slide.assetNeeds ?? []) {
        if (generatedAssets.length >= MAX_GENERATED_ASSETS) {
          break;
        }
        if (coveredRoles.has(need)) {
          continue;
        }
        const generated = await input.deps.image.generate({
          prompt: `${input.payload.project.globalVisualDirection}. A ${need.replace(/_/gu, " ")} visual for a presentation slide titled "${slide.title}": ${slide.sceneIntent}. High quality, no text, no lettering, no watermarks.`,
          metadata: {
            artifactId: input.artifactId,
            slideNumber: slide.slideNumber,
          },
        });
        if (!generated) {
          continue;
        }
        const assetId = `generated-${slide.slideNumber}-${safeStorageSegment(need)}`;
        const stored = await storeAssetBytes({
          artifactId: input.artifactId,
          assetId,
          data: generated.data,
          deps: input.deps,
          mimeType: generated.mimeType,
          workspaceId: input.workspaceId,
        });
        generatedAssets.push({
          assetId,
          type: (GENERATABLE_ASSET_TYPES.has(need)
            ? need
            : "editorial_illustration") as VideoPresentationAsset["type"],
          prompt: `Generated ${need} for slide ${slide.slideNumber}: ${slide.sceneIntent}`,
          slideNumbers: [slide.slideNumber],
          source: "generated",
          ...stored,
        });
        const extras = extraRefsBySlide.get(slide.slideNumber) ?? [];
        extras.push({ assetId, role: need });
        extraRefsBySlide.set(slide.slideNumber, extras);
        coveredRoles.add(need);
      }
    }
  }

  const slides = input.payload.slides.map((slide) => {
    const extras = extraRefsBySlide.get(slide.slideNumber);
    if (!extras || extras.length === 0) {
      return slide;
    }
    return { ...slide, assetRefs: [...slide.assetRefs, ...extras] };
  });

  return { assets: [...provided, ...generatedAssets], slides };
}

/**
 * Targeted storyboard regeneration for edit runs: rewrite ONLY the listed
 * slides (keeping their slide numbers) while every other slide's entry stays
 * byte-identical. The prompt carries the full current storyboard for
 * narrative coherence plus the user's edit instruction; the same density and
 * narration budgets apply to the rewritten slides.
 */
export async function regenerateStoryboardSlides(input: {
  deps: VideoPipelineDeps;
  state: VideoPresentationProjectPayload;
  request: VideoPresentationCreateRequest;
  targetSlideNumbers: readonly number[];
  instruction: string;
}): Promise<VideoPresentationProjectPayload["slides"]> {
  const targets = [...new Set(input.targetSlideNumbers)].sort((a, b) => a - b);
  const maxSlideNumber = Math.max(
    ...input.state.slides.map((slide) => slide.slideNumber),
  );
  const renderProfile = input.state.renderProfile;
  const budget = narrationBudgetSecondsPerSlide(renderProfile.durationTarget);
  const outputSchema = z
    .object({
      slides: z.array(storyboardSlideSchema(maxSlideNumber)).length(
        targets.length,
      ),
    })
    .strict();
  const targetSet = new Set(targets);

  const currentStoryboard = input.state.slides.map((slide) => ({
    slideNumber: slide.slideNumber,
    title: slide.title,
    subtitle: slide.subtitle ?? null,
    contentMarkdown: slide.contentMarkdown ?? null,
    speakerTranscript: slide.speakerTranscript,
    sceneIntent: slide.sceneIntent,
  }));

  let response: unknown;
  try {
    response = await input.deps.llm.completeStructured({
      temperature: 0.55,
      maxTokens: 2400,
      schema: z.toJSONSchema(outputSchema),
      schemaName: "video_presentation_storyboard_edit",
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
        const returnedNumbers = check.data.slides.map(
          (slide) => slide.slideNumber,
        );
        const unexpected = returnedNumbers.filter(
          (slideNumber) => !targetSet.has(slideNumber),
        );
        if (
          unexpected.length > 0 ||
          new Set(returnedNumbers).size !== targets.length
        ) {
          return {
            ok: false,
            feedback: summarizeStructuredValidationError({
              parsed,
              extra: `Return exactly one entry for each of these slide numbers, unchanged: ${targets.join(", ")}.`,
            }),
          };
        }
        const budgetIssues = narrationBudgetIssues({
          slides: check.data.slides,
          target: renderProfile.durationTarget,
        });
        if (budgetIssues.length > 0) {
          return {
            ok: false,
            feedback: summarizeStructuredValidationError({
              parsed,
              extra: `Narration pacing is off budget:\n${budgetIssues.join("\n")}`,
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
            "You revise slides inside an existing narrated video presentation.",
            `Regenerate ONLY slides ${targets.join(", ")} following the supplied response schema; keep each regenerated slide's slideNumber unchanged.`,
            "Stay coherent with the surrounding slides (tone, terminology, narrative flow); do not contradict or repeat them.",
            "Use null for optional text fields when they are not needed.",
            "Keep narration natural for spoken audio. Do not include code.",
            "Density budget (hard limits): one core idea per slide; title <= 60 chars; subtitle <= 90 chars; contentMarkdown is a distillation of at most ~5 short lines (<= 400 chars total).",
            `Narration pacing: each slide's spoken narration must take ${budget.min}-${budget.max} seconds when read aloud (~2.45 words/sec in English, ~5.2 chars/sec in Chinese).`,
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Current storyboard (full presentation):\n${JSON.stringify(currentStoryboard, null, 2)}`,
            `Edit instruction from the user:\n${input.instruction}`,
            `Regenerate slides: ${targets.join(", ")}`,
            `Language: ${renderProfile.language}`,
            `Style: ${renderProfile.stylePreset}`,
            `Visual direction: ${input.state.project.globalVisualDirection}`,
            ...(input.state.project.brand?.colors?.length
              ? [`Brand colors: ${input.state.project.brand.colors.join(", ")}`]
              : []),
            ...(input.state.project.brand?.typography
              ? [`Typography: ${input.state.project.brand.typography}`]
              : []),
            ...(input.state.project.motion?.pacing
              ? [`Motion pacing: ${input.state.project.motion.pacing}`]
              : []),
          ].join("\n\n"),
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw videoPresentationProviderError(
      "VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED",
      `Storyboard edit provider call failed: ${message}`,
    );
  }

  const parsed = outputSchema.safeParse(response);
  if (!parsed.success) {
    throw videoPresentationProviderError(
      "VIDEO_PRESENTATION_STORYBOARD_GENERATION_FAILED",
      `Storyboard edit provider returned invalid structured content for slides ${targets.join(", ")}.`,
    );
  }
  const replacementBySlide = new Map(
    parsed.data.slides.map((slide) => [slide.slideNumber, slide]),
  );
  const assetRefs = input.request.assets ?? [];

  return input.state.slides.map((slide) => {
    const replacement = replacementBySlide.get(slide.slideNumber);
    if (!replacement) {
      return slide;
    }
    return {
      slideNumber: slide.slideNumber,
      title: replacement.title,
      ...(replacement.subtitle ? { subtitle: replacement.subtitle } : {}),
      ...(replacement.contentMarkdown
        ? { contentMarkdown: replacement.contentMarkdown }
        : {}),
      speakerTranscript: replacement.speakerTranscript,
      ...(replacement.backgroundExplanation
        ? { backgroundExplanation: replacement.backgroundExplanation }
        : {}),
      sceneIntent: replacement.sceneIntent,
      assetNeeds: replacement.assetNeeds,
      assetRefs: assetRefsForSlide({
        assetRefs,
        assetNeeds: replacement.assetNeeds,
        sceneIntent: replacement.sceneIntent,
      }),
    };
  });
}
