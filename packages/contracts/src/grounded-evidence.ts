import { z } from "zod";

/**
 * Evidence for generated content that must be supported by source text: a
 * chunk reference plus the quote that supports it. The quote is source text,
 * never model output. Shared by every artifact type that grounds its output
 * in sources (study items, data tables).
 */

/** Default ceiling for one quote, in characters. */
export const GROUNDED_QUOTE_CHARS = 600;

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Where a generated item came from; the quote is source text, not model output. */
export function groundedEvidenceSchema(
  limits: { quoteChars: number } = { quoteChars: GROUNDED_QUOTE_CHARS },
) {
  return z
    .object({
      kind: z.literal("chunk"),
      sourceId: z.string().min(1),
      documentId: z.string().min(1),
      chunkId: z.string().min(1),
      chunkNo: z.number().int().nonnegative().optional(),
      headingPath: z.string().nullable().optional(),
      quote: z.string().min(1).max(limits.quoteChars),
      /** Range of the quote inside the chunk, once anchored. */
      startChar: z.number().int().nonnegative().optional(),
      endChar: z.number().int().nonnegative().optional(),
      /** `sha256:` of `quote`; tells a viewer whether the source text moved. */
      quoteHash: sha256DigestSchema,
    })
    .refine(
      (value) =>
        value.startChar === undefined ||
        value.endChar === undefined ||
        value.endChar >= value.startChar,
      { message: "endChar must not precede startChar", path: ["endChar"] },
    );
}

export type GroundedEvidence = z.infer<ReturnType<typeof groundedEvidenceSchema>>;
