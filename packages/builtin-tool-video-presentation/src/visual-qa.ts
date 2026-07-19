import { z } from "zod";

/**
 * Visual QA for rendered slide stills: the worker renders one frame per slide
 * in the sandbox, sends batches to the default vision model, and repairs
 * slides with severe findings. This module owns the judge prompt and the
 * verdict wire shape so they stay testable outside the worker.
 */

export const VISUAL_QA_ISSUE_TYPES = [
  "text_cutoff",
  "edge_overflow",
  "overlap",
  "low_contrast",
] as const;

export const visualQaIssueSchema = z.object({
  type: z.enum(VISUAL_QA_ISSUE_TYPES),
  severity: z.enum(["minor", "severe"]),
  description: z.string().trim().min(1).max(500),
});

export const visualQaSlideVerdictSchema = z.object({
  slideNumber: z.number().int().min(1),
  ok: z.boolean(),
  issues: z.array(visualQaIssueSchema).max(8).default([]),
});

export const visualQaVerdictsSchema = z.object({
  verdicts: z.array(visualQaSlideVerdictSchema),
});

export type VisualQaSlideVerdict = z.infer<typeof visualQaSlideVerdictSchema>;

export function buildVisualQaJudgePrompt(input: {
  slideNumbers: number[];
  canvas: { width: number; height: number };
}) {
  return [
    "You are a strict visual QA reviewer for presentation video frames.",
    `You are shown ${input.slideNumbers.length} rendered slide frame(s), in order, for slides: ${input.slideNumbers.join(", ")}. Canvas: ${input.canvas.width}x${input.canvas.height}.`,
    "For each frame, check ONLY these defects:",
    "- text_cutoff: text clipped by the frame edge or a container (letters visibly cut).",
    "- edge_overflow: any foreground content touching or crossing the outer ~5% margin of the frame.",
    "- overlap: text overlapping other text or a busy graphic so it is hard to read.",
    "- low_contrast: text nearly unreadable against its background.",
    'Severity: "severe" means a viewer would immediately notice the defect or fail to read the content; otherwise "minor".',
    "Do not judge aesthetics, style, color taste, or animation. A plain but readable slide is ok.",
    "Provided asset images may fail to load in this offline preview; do NOT flag broken, blank, or missing images as defects.",
    "Respond with ONLY minified JSON, no markdown fences, matching:",
    '{"verdicts":[{"slideNumber":<number>,"ok":<boolean>,"issues":[{"type":"text_cutoff"|"edge_overflow"|"overlap"|"low_contrast","severity":"minor"|"severe","description":"<what and where, one sentence>"}]}]}',
    "Return one verdict per shown slide, using the slide numbers given above.",
  ].join("\n");
}

export function parseVisualQaVerdicts(raw: string): VisualQaSlideVerdict[] | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  try {
    const parsed = visualQaVerdictsSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data.verdicts : null;
  } catch {
    return null;
  }
}
