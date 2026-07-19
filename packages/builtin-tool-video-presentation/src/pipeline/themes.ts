import { z } from "zod";
import {
  VIDEO_PRESENTATION_ERROR_CODES,
  type VideoPresentationProjectPayload,
  type VideoPresentationThemeAssignment,
} from "@sourceweft/contracts/video-presentation";
import {
  VIDEO_PRESENTATION_THEME_DESCRIPTIONS,
  VIDEO_PRESENTATION_THEME_PRESETS,
} from "../theme-presets";
import type { VideoPipelineDeps } from "./deps";
import { videoPresentationProviderError } from "./errors";
import { summarizeStructuredValidationError } from "./storyboard";

const {
  themeAssignmentFailed: VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED,
} = VIDEO_PRESENTATION_ERROR_CODES;

export function themeAssignmentsOutputSchema(slideCount: number) {
  return z
    .object({
      assignments: z
        .array(
          z
            .object({
              slideNumber: z.number().int().min(1).max(slideCount),
              themeName: z.enum(VIDEO_PRESENTATION_THEME_PRESETS),
              mode: z.enum(["light", "dark"]),
            })
            .strict(),
        )
        .length(slideCount),
    })
    .strict();
}

export async function assignSlideThemes(input: {
  deps: VideoPipelineDeps;
  payload: VideoPresentationProjectPayload;
}) {
  const outputSchema = themeAssignmentsOutputSchema(
    input.payload.slides.length,
  );
  let response: unknown;
  try {
    response = await input.deps.llm.completeStructured({
      temperature: 0.35,
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
            "Return only the structured JSON defined by the response schema.",
            "Do not include explanations, reasoning, markdown, or any text outside the schema.",
            `Assign exactly one theme to every slide from 1 to ${input.payload.slides.length}.`,
            "Maximize visual rhythm and avoid repeating the same theme on consecutive slides.",
            ...(input.payload.project.brand?.colors?.length
              ? [
                  `The presentation has a brand palette (${input.payload.project.brand.colors.join(", ")}); pick themes whose color families harmonize with it — scene code will prioritize the brand palette over theme colors.`,
                ]
              : []),
            `Available themes:\n${VIDEO_PRESENTATION_THEME_DESCRIPTIONS}`,
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
