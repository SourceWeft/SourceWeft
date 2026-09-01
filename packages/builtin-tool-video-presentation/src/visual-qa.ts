import { z } from "zod";

/**
 * Visual QA for trusted sandbox scene samples. The validator sends bounded
 * batches to the configured vision model and returns defects as evidence for
 * the root Agent. This module owns only the judge prompt and verdict shape.
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

export type VideoStillForReview = {
  slideNumber: number;
  data: Uint8Array;
  mimeType?: string;
};

export type StillReviewResult = {
  verdicts: VisualQaSlideVerdict[];
  /** Slide-number batches whose provider response was not a valid verdict. */
  unparseableBatches: number[][];
};

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

export function parseVisualQaVerdicts(
  raw: string,
): VisualQaSlideVerdict[] | null {
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

/**
 * Run only the visual-review batching/judging step.
 *
 * This seam intentionally does not repair scene code or decide whether an
 * unavailable or partial review is acceptable. The current validation flow
 * applies that policy around these review facts.
 */
export async function reviewStills(input: {
  stills: readonly VideoStillForReview[];
  canvas: { width: number; height: number };
  batchSize: number;
  metadata: Record<string, unknown>;
  completeVision: (input: {
    images: Array<{ data: Uint8Array; mimeType: string }>;
    metadata: Record<string, unknown>;
    prompt: string;
  }) => Promise<string>;
  onUnparseableBatch?: (slideNumbers: readonly number[]) => void;
}): Promise<StillReviewResult> {
  if (!Number.isInteger(input.batchSize) || input.batchSize <= 0) {
    throw new RangeError("Still review batchSize must be a positive integer");
  }

  const verdicts: VisualQaSlideVerdict[] = [];
  const unparseableBatches: number[][] = [];
  for (
    let offset = 0;
    offset < input.stills.length;
    offset += input.batchSize
  ) {
    const batch = input.stills.slice(offset, offset + input.batchSize);
    const slideNumbers = batch.map((still) => still.slideNumber);
    const raw = await input.completeVision({
      images: batch.map((still) => ({
        data: still.data,
        mimeType: still.mimeType ?? "image/jpeg",
      })),
      metadata: { ...input.metadata },
      prompt: buildVisualQaJudgePrompt({
        slideNumbers,
        canvas: input.canvas,
      }),
    });
    const parsed = parseVisualQaVerdicts(raw);
    if (!parsed) {
      unparseableBatches.push(slideNumbers);
      input.onUnparseableBatch?.(slideNumbers);
      continue;
    }
    verdicts.push(...parsed);
  }

  return { verdicts, unparseableBatches };
}
