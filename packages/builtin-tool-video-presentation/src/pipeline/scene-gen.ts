import ts from "typescript";
import {
  VIDEO_PRESENTATION_ERROR_CODES,
  VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS,
  type VideoPresentationAudioTrack,
  type VideoPresentationProjectPayload,
  type VideoPresentationSceneModule,
  type VideoPresentationThemeAssignment,
} from "@sourceweft/contracts/video-presentation";
import { VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES } from "@sourceweft/video-presentation-runtime/layout-source";
import { lintSceneLayout } from "../scene-lint";
import {
  buildVisualQaJudgePrompt,
  parseVisualQaVerdicts,
  type VisualQaSlideVerdict,
} from "../visual-qa";
import {
  MAX_REPAIR_ATTEMPTS,
  VIDEO_SCENE_COMPONENT_NAME,
  VISUAL_QA_BATCH_SIZE,
} from "./config";
import type { VideoPipelineDeps } from "./deps";
import { videoPresentationProviderError } from "./errors";
import { durationTargetFallbackSeconds } from "./storyboard";
import { VIDEO_STYLE_PRESET_DIRECTIONS } from "./style-directions";

const {
  themeAssignmentFailed: VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
} = VIDEO_PRESENTATION_ERROR_CODES;

/**
 * The layout-primitives surface, spelled out once. Both prompts and the import
 * statement injected into every generated scene derive from this, so the model
 * can never be told about a primitive the sandbox project does not import.
 */
const LAYOUT_PRIMITIVE_LIST = VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES.join(", ");

export const LAYOUT_PRIMITIVES_PROMPT_LINE =
  `These layout globals are also available (no import needed): ${LAYOUT_PRIMITIVE_LIST}.`;

export const LAYOUT_PRIMITIVES_IMPORT_STATEMENT =
  `import { ${LAYOUT_PRIMITIVE_LIST} } from "./layout-primitives";`;

function sceneAssetUrls(payload: VideoPresentationProjectPayload): string[] {
  return payload.assets
    .map((asset) => asset.sourceUrl)
    .filter((url): url is string => Boolean(url));
}

export function stripMarkdownFences(value: string) {
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

export function extractJsonObject(value: string): Record<string, unknown> | null {
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

export function extractSceneCodeAndTitle(value: string) {
  const object = extractJsonObject(value);
  if (object && typeof object.code === "string") {
    return {
      code: stripMarkdownFences(object.code),
      title: typeof object.title === "string" ? object.title.trim() : null,
    };
  }
  return { code: stripMarkdownFences(value), title: null };
}

export function sceneSystemPrompt() {
  return [
    "You are a senior motion designer and Remotion React engineer.",
    `Generate ONE self-contained React component exported as: export default function ${VIDEO_SCENE_COMPONENT_NAME}() { ... }`,
    "The code must be raw TSX/JSX only. Do not include markdown fences or explanations.",
    "Use only React and these Remotion globals/imports: AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig.",
    LAYOUT_PRIMITIVES_PROMPT_LINE,
    "Provided images: when the slide lists available assets (with urls), you may display them via <AssetImage src=\"...\"> using EXACTLY those urls, inside SafeArea (e.g. one pane of a SplitLayout). NEVER invent, guess, or construct any other image URL; with no assets listed, use no images.",
    "Imports from 'react' and 'remotion' are allowed. Do not import any external dependency, CSS, font, data file, or package.",
    "Use inline styles only. No className, no DOM APIs, no fetch, no timers, no random values.",
    "Layout contract (mandatory):",
    "- ALL text, numbers, labels, and foreground imagery MUST be descendants of exactly one <SafeArea>. Only full-bleed backgrounds, gradients, and decorative shapes may live directly under AbsoluteFill, and they must not cover SafeArea content.",
    "- Never position text with absolute top/left/right/bottom values; arrange content with flex inside SafeArea (align/justify/gap props, or SplitLayout for two panes).",
    "- Derive font sizes from useVideoConfig(): titles <= height * 0.075, body text <= height * 0.032. Never hardcode sizes beyond these, and never use negative margins.",
    "- Animate with transform/opacity only; entrance offsets must settle at their final in-SafeArea position. Never animate width/height/fontSize of text.",
    "- Give the scene a deliberate ENTRANCE and a graceful EXIT so the cut to the next scene is never abrupt: elements ease in and settle at the start, then the whole composition eases out (fade/scale/slide via transform/opacity) across the final narration-free tail. Do NOT hold a frozen frame into the boundary — the user message states the exact frame window and where the silent tail begins.",
    "- The style preset's motion character and the supplied motion settings (pacing, animationIntensity, transitionStyle) decide HOW the entrance and exit feel — you author the actual transition; there is no cross-scene transition layer, each scene owns its own in/out.",
    "Honor the style preset direction, brand palette/typography and motion settings supplied in the user message; when a brand palette is supplied it overrides the theme's colors (the theme then only guides light/dark mode and rhythm).",
    "Do NOT dump markdown on screen. Extract only 1-2 high-impact visual phrases, numbers, metaphors, or labels.",
    "Vary layout and motion per slide: cinematic opener, editorial spread, process map, comparison, kinetic type, diagram, quote, or recap as appropriate.",
    "Use the provided theme as inspiration, but do not force a fixed template.",
  ].join("\n");
}

export function buildSceneUserPrompt(input: {
  audioTrack?: VideoPresentationAudioTrack;
  nextSlide?: VideoPresentationProjectPayload["slides"][number];
  payload: VideoPresentationProjectPayload;
  previousSlide?: VideoPresentationProjectPayload["slides"][number];
  slide: VideoPresentationProjectPayload["slides"][number];
  theme: VideoPresentationThemeAssignment;
}) {
  const durationSeconds = input.audioTrack
    ? input.audioTrack.durationSeconds +
      VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS
    : durationTargetFallbackSeconds(input.payload.renderProfile.durationTarget);
  const fps = input.payload.project.fps;
  // Mirror the runtime scene length (see generateSceneModules) so the frame
  // numbers the model animates against are exactly the ones it is given.
  const totalFrames = Math.max(60, Math.ceil(durationSeconds * fps));
  const tailFrames = Math.round(
    VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS * fps,
  );
  const entranceFrames = Math.max(6, Math.round(0.35 * fps));
  const stylePreset = input.payload.renderProfile.stylePreset;
  const brand = input.payload.project.brand;
  const motion = input.payload.project.motion;
  const brandLines = [
    brand?.colors?.length
      ? `Brand palette (MUST take priority over the theme's colors): ${brand.colors.join(", ")}`
      : null,
    brand?.typography ? `Brand typography: ${brand.typography}` : null,
  ].filter((line): line is string => line !== null);
  const motionParts = [
    motion?.pacing ? `pacing=${motion.pacing}` : null,
    motion?.animationIntensity ? `intensity=${motion.animationIntensity}` : null,
    motion?.transitionStyle ? `transitions=${motion.transitionStyle}` : null,
  ].filter((part): part is string => part !== null);
  return [
    `Create slide ${input.slide.slideNumber} of ${input.payload.slides.length}.`,
    `Duration: ${durationSeconds.toFixed(1)}s at ${fps}fps = ${totalFrames} frames total; useCurrentFrame() runs 0..${totalFrames - 1}.`,
    `Transitions (this scene owns its own in/out): animate the scene IN over roughly the first ${entranceFrames} frames and settle at the final in-SafeArea position; hold while the narration plays; then ease the scene OUT across the final ~${tailFrames} frames (the narration-free tail) so the handoff to the next scene is smooth. Never cut from a frozen frame; keep the exit to transform/opacity.`,
    `Canvas: ${input.payload.project.width}x${input.payload.project.height}.`,
    `Safe area (6% margins, already applied by <SafeArea>): content lands inside x:[${Math.round(input.payload.project.width * 0.06)}..${Math.round(input.payload.project.width * 0.94)}] y:[${Math.round(input.payload.project.height * 0.06)}..${Math.round(input.payload.project.height * 0.94)}]. Max on-screen text: ~90 characters across at most 3 text elements.`,
    `Theme: ${input.theme.themeName} / ${input.theme.mode}.`,
    `Global visual direction: ${input.payload.project.globalVisualDirection}`,
    `Render profile: ${JSON.stringify(input.payload.renderProfile)}`,
    `Style preset direction (${stylePreset}):\n${VIDEO_STYLE_PRESET_DIRECTIONS[stylePreset]}`,
    ...brandLines,
    ...(motionParts.length > 0
      ? [`Motion: ${motionParts.join(", ")}`]
      : []),
    `Presentation title: ${input.payload.project.title}`,
    "",
    `Slide title: ${input.slide.title}`,
    `Subtitle: ${input.slide.subtitle ?? ""}`,
    `Scene intent: ${input.slide.sceneIntent}`,
    `Mood/background explanation: ${input.slide.backgroundExplanation ?? ""}`,
    `Content markdown for meaning only, not literal rendering:\n${input.slide.contentMarkdown ?? ""}`,
    `Narration:\n${input.slide.speakerTranscript.join(" ")}`,
    `Available assets for this slide (use AssetImage with these exact urls, or none):\n${JSON.stringify(
      input.slide.assetRefs
        .map((assetRef) => {
          const asset = input.payload.assets.find(
            (candidate) => candidate.assetId === assetRef.assetId,
          );
          return asset?.sourceUrl
            ? { assetId: assetRef.assetId, role: assetRef.role, url: asset.sourceUrl }
            : null;
        })
        .filter(Boolean),
      null,
      2,
    )}`,
    `Previous slide: ${input.previousSlide?.title ?? "none"}`,
    `Next slide: ${input.nextSlide?.title ?? "none"}`,
    "",
    "Return raw component code only.",
  ].join("\n");
}

export function basicSceneCheck(code: string) {
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
    .filter(
      (source) =>
        source !== "react" &&
        source !== "remotion" &&
        source !== "./layout-primitives",
    );
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

export function typescriptSceneSyntaxDiagnostics(code: string) {
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

export function normalizeSceneProjectCode(code: string) {
  const withoutAllowedImports = code
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["']react["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["']remotion["'];?\s*$/gm, "")
    .replace(
      /^\s*import\s+[\s\S]*?\s+from\s+["']\.\/layout-primitives["'];?\s*$/gm,
      "",
    );
  return [
    'import React, { type CSSProperties } from "react";',
    'import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";',
    LAYOUT_PRIMITIVES_IMPORT_STATEMENT,
    "",
    withoutAllowedImports.trim(),
  ].join("\n");
}

export async function repairSceneModule(input: {
  allowedImageUrls?: readonly string[];
  canvas: { width: number; height: number };
  deps: VideoPipelineDeps;
  diagnostics: string[];
  maxAttempts?: number;
  sceneCode: string;
  slide: VideoPresentationProjectPayload["slides"][number];
}) {
  let code = input.sceneCode;
  let diagnostics = input.diagnostics;
  const maxAttempts = input.maxAttempts ?? MAX_REPAIR_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
            "Keep the scene's established brand palette and style preset direction intact: do not change its colors, typography treatment, or motion character while repairing.",
            `${LAYOUT_PRIMITIVES_PROMPT_LINE} Keep all text content inside one <SafeArea>; do not remove it while repairing.`,
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
    diagnostics = [
      ...basicSceneCheck(code),
      ...lintSceneLayout(code, input.canvas, {
        allowedImageUrls: input.allowedImageUrls,
      }).errors,
    ];
    if (diagnostics.length === 0) {
      return { code, diagnostics: [], repairAttempts: attempt };
    }
  }

  return { code, diagnostics, repairAttempts: maxAttempts };
}

export async function generateSceneModules(input: {
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
  /**
   * Edit runs: regenerate scene code only for these slides; every other
   * slide reuses its existing scene module (code, duration, warnings).
   */
  onlySlideNumbers?: ReadonlySet<number>;
}) {
  const themeBySlide = new Map(
    input.payload.themeAssignments.map((theme) => [theme.slideNumber, theme]),
  );
  const audioBySlide = new Map(
    input.payload.audioTracks.map((track) => [track.slideNumber, track]),
  );
  const existingSceneBySlide = new Map(
    input.payload.sceneModules.map((scene) => [scene.slideNumber, scene]),
  );

  return Promise.all(
    input.payload.slides.map(async (slide, index) => {
      const existingScene = existingSceneBySlide.get(slide.slideNumber);
      if (
        input.onlySlideNumbers &&
        !input.onlySlideNumbers.has(slide.slideNumber) &&
        existingScene
      ) {
        return existingScene;
      }
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
      const lint = lintSceneLayout(
        code,
        {
          width: input.payload.project.width,
          height: input.payload.project.height,
        },
        { allowedImageUrls: sceneAssetUrls(input.payload) },
      );
      const diagnostics = [...basicSceneCheck(code), ...lint.errors];
      const audioTrack = audioBySlide.get(slide.slideNumber);
      const durationSeconds = audioTrack
        ? audioTrack.durationSeconds +
          VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS
        : durationTargetFallbackSeconds(
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
        layoutWarnings: lint.warnings,
        repairAttempts: 0,
      } satisfies VideoPresentationSceneModule;
    }),
  );
}

/**
 * Judge rendered slide stills with the vision model and give slides with
 * severe findings one targeted repair round. Never throws for infra reasons —
 * a missing vision profile, unparseable verdicts, or judge failures degrade
 * to "accept as-is" (minor findings are recorded as layoutWarnings).
 */
export async function runVisualQualityCheck(input: {
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
  stills: Array<{ slideNumber: number; data: Uint8Array }>;
  /** Edit runs: judge only these slides' stills. */
  onlySlideNumbers?: ReadonlySet<number>;
}): Promise<{ sceneModules: VideoPresentationSceneModule[] } | null> {
  const completeVision = input.deps.llm.completeVision;
  const stills = input.onlySlideNumbers
    ? input.stills.filter((still) =>
        input.onlySlideNumbers!.has(still.slideNumber),
      )
    : input.stills;
  if (!completeVision || stills.length === 0) {
    return null;
  }
  const canvas = {
    width: input.payload.project.width,
    height: input.payload.project.height,
  };

  const verdicts: VisualQaSlideVerdict[] = [];
  for (
    let offset = 0;
    offset < stills.length;
    offset += VISUAL_QA_BATCH_SIZE
  ) {
    const batch = stills.slice(offset, offset + VISUAL_QA_BATCH_SIZE);
    const raw = await completeVision({
      images: batch.map((still) => ({
        data: still.data,
        mimeType: "image/jpeg",
      })),
      metadata: {
        feature: "video_presentation",
        stage: "visual_qa",
      },
      prompt: buildVisualQaJudgePrompt({
        slideNumbers: batch.map((still) => still.slideNumber),
        canvas,
      }),
    });
    const parsed = parseVisualQaVerdicts(raw);
    if (!parsed) {
      input.deps.logger.warn("video_presentation_visual_qa_unparseable_verdict", {
        slideNumbers: batch.map((still) => still.slideNumber),
      });
      continue;
    }
    verdicts.push(...parsed);
  }
  if (verdicts.length === 0) {
    return null;
  }

  const verdictBySlide = new Map(
    verdicts.map((verdict) => [verdict.slideNumber, verdict]),
  );
  const slideByNumber = new Map(
    input.payload.slides.map((slide) => [slide.slideNumber, slide]),
  );
  const sceneModules = await Promise.all(
    input.payload.sceneModules.map(async (scene) => {
      const verdict = verdictBySlide.get(scene.slideNumber);
      if (!verdict || verdict.issues.length === 0) {
        return scene;
      }
      const issueNotes = verdict.issues.map(
        (issue) =>
          `Visual QA (${issue.severity} ${issue.type}): ${issue.description}`,
      );
      const severeIssues = verdict.issues.filter(
        (issue) => issue.severity === "severe",
      );
      const slide = slideByNumber.get(scene.slideNumber);
      if (severeIssues.length === 0 || !slide) {
        return {
          ...scene,
          layoutWarnings: [...(scene.layoutWarnings ?? []), ...issueNotes],
        } satisfies VideoPresentationSceneModule;
      }
      const repaired = await repairSceneModule({
        allowedImageUrls: sceneAssetUrls(input.payload),
        canvas,
        deps: input.deps,
        diagnostics: severeIssues.map(
          (issue) =>
            `Rendered-frame QA found a ${issue.severity} ${issue.type} defect: ${issue.description}. Fix the layout so the content is fully visible and readable; keep everything inside <SafeArea>.`,
        ),
        maxAttempts: 1,
        sceneCode: scene.code,
        slide,
      });
      if (repaired.diagnostics.length > 0) {
        // Repair made it worse — keep the rendered-and-verified original and
        // surface the findings for observability.
        return {
          ...scene,
          layoutWarnings: [...(scene.layoutWarnings ?? []), ...issueNotes],
        } satisfies VideoPresentationSceneModule;
      }
      return {
        ...scene,
        code: repaired.code,
        compileStatus: "repaired" as const,
        diagnostics: [],
        layoutWarnings: [
          ...lintSceneLayout(repaired.code, canvas).warnings,
          ...issueNotes,
        ],
        repairAttempts: scene.repairAttempts + repaired.repairAttempts,
      } satisfies VideoPresentationSceneModule;
    }),
  );
  return { sceneModules };
}

export async function repairSceneModules(input: {
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
}) {
  const bySlide = new Map(
    input.payload.slides.map((slide) => [slide.slideNumber, slide]),
  );
  const canvas = {
    width: input.payload.project.width,
    height: input.payload.project.height,
  };
  return Promise.all(
    input.payload.sceneModules.map(async (scene) => {
      const hasErrors =
        scene.diagnostics.length > 0 || scene.compileStatus === "failed";
      const warnings = scene.layoutWarnings ?? [];
      if (!hasErrors && warnings.length === 0) {
        return scene;
      }
      const slide = bySlide.get(scene.slideNumber);
      if (!slide) return scene;

      if (!hasErrors) {
        // Layout warnings only: one targeted repair attempt, then accept the
        // best available code — warnings must never fail the pipeline.
        const repaired = await repairSceneModule({
          allowedImageUrls: sceneAssetUrls(input.payload),
          canvas,
          deps: input.deps,
          diagnostics: warnings.map((warning) => `Layout warning: ${warning}`),
          maxAttempts: 1,
          sceneCode: scene.code,
          slide,
        });
        if (repaired.diagnostics.length > 0) {
          return scene;
        }
        return {
          ...scene,
          code: repaired.code,
          diagnostics: [],
          layoutWarnings: lintSceneLayout(repaired.code, canvas).warnings,
          repairAttempts: repaired.repairAttempts,
          compileStatus: "repaired",
        } satisfies VideoPresentationSceneModule;
      }

      const repaired = await repairSceneModule({
        allowedImageUrls: sceneAssetUrls(input.payload),
        canvas,
        deps: input.deps,
        diagnostics: scene.diagnostics,
        sceneCode: scene.code,
        slide,
      });
      return {
        ...scene,
        code: repaired.code,
        diagnostics: repaired.diagnostics,
        layoutWarnings:
          repaired.diagnostics.length === 0
            ? lintSceneLayout(repaired.code, canvas).warnings
            : (scene.layoutWarnings ?? []),
        repairAttempts: repaired.repairAttempts,
        compileStatus:
          repaired.diagnostics.length === 0 ? "repaired" : "failed",
      } satisfies VideoPresentationSceneModule;
    }),
  );
}
