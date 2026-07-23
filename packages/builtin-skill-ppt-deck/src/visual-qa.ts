import { z } from "zod";

/**
 * Visual QA for rendered deck slides: the agent renders slides to JPG in the
 * sandbox (LibreOffice + pdftoppm), `review_deck_visuals` sends batches to the
 * workspace's default vision model, and the agent repairs slides with severe
 * findings. This module owns the rubric, the judge prompt, and the verdict
 * wire shape so they stay testable outside the turn pipeline.
 *
 * The rubric is fixed here on purpose: the deck's visual standards belong to
 * this capability, not to whichever chat model happens to drive the turn.
 */

export const DECK_VISUAL_QA_ISSUE_TYPES = [
  "text_cutoff",
  "edge_overflow",
  "overlap",
  "low_contrast",
  "decorative_stripes",
  "cream_default",
  "bullet_only",
  "missing_promised_visual",
  "repeated_layout",
] as const;

export type DeckVisualQaIssueType = (typeof DECK_VISUAL_QA_ISSUE_TYPES)[number];

export const deckVisualQaIssueSchema = z.object({
  type: z.enum(DECK_VISUAL_QA_ISSUE_TYPES),
  severity: z.enum(["minor", "severe"]),
  description: z.string().trim().min(1).max(500),
});

export const deckVisualQaSlideVerdictSchema = z.object({
  slideNumber: z.number().int().min(1),
  ok: z.boolean(),
  issues: z.array(deckVisualQaIssueSchema).max(10).default([]),
});

export const deckVisualQaVerdictsSchema = z.object({
  verdicts: z.array(deckVisualQaSlideVerdictSchema),
});

export type DeckVisualQaSlideVerdict = z.infer<
  typeof deckVisualQaSlideVerdictSchema
>;

export function buildDeckVisualQaJudgePrompt(input: {
  slideNumbers: number[];
}) {
  return [
    "You are a strict visual QA reviewer for rendered presentation slides.",
    `You are shown ${input.slideNumbers.length} rendered slide image(s), in deck order, for slides: ${input.slideNumbers.join(", ")}.`,
    "For each slide, check ONLY these defects:",
    "- text_cutoff: text clipped by the slide edge or a container (letters visibly cut).",
    "- edge_overflow: any foreground content touching or crossing the outer ~3% margin of the slide.",
    "- overlap: text overlapping other text or a busy graphic so it is hard to read.",
    "- low_contrast: text nearly unreadable against its background.",
    "- decorative_stripes: title underline accents, decorative color bars, header/footer stripes, sidebar stripes, or card edge stripes used as the slide's visual system.",
    "- cream_default: a cream or beige page background on a slide whose design clearly is not a deliberate blackboard/notebook/academic paper theme.",
    "- bullet_only: the slide is a title plus plain bullet text with no meaningful visual structure (no diagram, chart, image, comparison, timeline, or shaped layout).",
    "- missing_promised_visual: the slide's own text promises a chart, photo, screenshot, diagram, logo, or similar visual that is not visible on the slide.",
    "- repeated_layout: this slide and at least the two shown immediately before it use a near-identical layout.",
    'Severity: "severe" means a viewer would immediately notice the defect or fail to read the content; otherwise "minor". bullet_only and repeated_layout are at most "minor" unless most of the shown slides have the same defect.',
    "Do not judge aesthetics, color taste, or wording. A distinctive but readable slide is ok.",
    "Respond with ONLY minified JSON, no markdown fences, matching:",
    '{"verdicts":[{"slideNumber":<number>,"ok":<boolean>,"issues":[{"type":"<one of the defect names above>","severity":"minor"|"severe","description":"<what and where, one sentence>"}]}]}',
    "Return one verdict per shown slide, using the slide numbers given above.",
  ].join("\n");
}

export function parseDeckVisualQaVerdicts(
  raw: string,
): DeckVisualQaSlideVerdict[] | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  try {
    const parsed = deckVisualQaVerdictsSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data.verdicts : null;
  } catch {
    return null;
  }
}

/**
 * Deck-level conclusions the per-slide judge cannot state on its own. Plain
 * code, not another model call: the per-slide verdicts already carry the
 * signal, this only reads it across the deck.
 */
export function aggregateDeckFindings(
  verdicts: readonly DeckVisualQaSlideVerdict[],
): string[] {
  const findings: string[] = [];
  if (verdicts.length === 0) {
    return findings;
  }
  const slidesWith = (type: DeckVisualQaIssueType) =>
    verdicts.filter((verdict) =>
      verdict.issues.some((issue) => issue.type === type),
    );
  const bulletOnly = slidesWith("bullet_only");
  if (bulletOnly.length * 2 > verdicts.length) {
    findings.push(
      `Deck reads as a document: ${bulletOnly.length} of ${verdicts.length} reviewed slides are title-plus-bullets with no meaningful visual structure (slides ${bulletOnly.map((verdict) => verdict.slideNumber).join(", ")}).`,
    );
  }
  const repeated = slidesWith("repeated_layout");
  if (repeated.length >= 2) {
    findings.push(
      `Layout monotony: near-identical consecutive layouts around slides ${repeated.map((verdict) => verdict.slideNumber).join(", ")}.`,
    );
  }
  return findings;
}

export function summarizeDeckVerdicts(
  verdicts: readonly DeckVisualQaSlideVerdict[],
) {
  let severeCount = 0;
  let minorCount = 0;
  for (const verdict of verdicts) {
    for (const issue of verdict.issues) {
      if (issue.severity === "severe") severeCount += 1;
      else minorCount += 1;
    }
  }
  return { severeCount, minorCount };
}
