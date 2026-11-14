/**
 * How a citation's anchor was decided (#516). Numbers and enums only: nothing
 * here may carry a claim or a passage, because it is stored with every
 * citation and used to calibrate the thresholds on real traffic.
 */
export type AnchoringScripts = "cjk>latin" | "latin>cjk" | "same";

export type SemanticOutcome =
  | "strong"
  | "below_similarity"
  | "below_margin"
  | "figures_missing"
  | "direction_conflict"
  | "over_budget"
  | "embedding_failed";

export type SemanticDiagnostics = {
  /** Cosine similarity of the best sentence; null when nothing was compared. */
  similarity: number | null;
  /** Lead over the next sentence; null with a single sentence or no comparison. */
  margin: number | null;
  /** Sentences of the source that were compared (or would have been). */
  segments: number;
  outcome: SemanticOutcome;
};

export type AnchorDiagnostics = {
  /** "semantic" when the citation went through (or was refused) the by-meaning pass. */
  method: "lexical" | "semantic";
  scripts: AnchoringScripts;
  lexicalScore: number;
  semantic?: SemanticDiagnostics;
};

/** One answer's counts, logged as `citation.anchoring.summary`. No text. */
export type AnchoringSummary = {
  /** Used citations whose source content was available. */
  citations: number;
  /** Strong after the word matcher alone. */
  lexicalStrong: number;
  /** Citations sent to the by-meaning pass. */
  sentToSemantic: number;
  /** Of those, how many it judged strong. */
  semanticStrong: number;
  /** Citations the by-meaning pass skipped because the bounds were full. */
  overBudget: number;
  embeddedTexts: number;
  embeddedCharacters: number;
  boundsHit: boolean;
  /** Wall time of the embedding call; null when none was made. */
  embeddingMs: number | null;
  embeddingFailed: boolean;
};

/**
 * The observability feature and trace-id suffix of the by-meaning pass's
 * embedding call. The gateway sink records the call as an `llm_generations`
 * row whose trace id is the scope id, and does not store `feature` on that
 * row, so the report finds these calls by the suffix.
 */
export const CITATION_ANCHORING_FEATURE = "citation-anchoring";
export const citationAnchoringScopeId = (messageId: string) =>
  `${messageId}:${CITATION_ANCHORING_FEATURE}`;

const round = (value: number) => Number(value.toFixed(4));

/** The stored shape: rounded, with no text. */
export function serializeDiagnostics(diagnostics: AnchorDiagnostics) {
  return {
    method: diagnostics.method,
    scripts: diagnostics.scripts,
    lexicalScore: round(diagnostics.lexicalScore),
    ...(diagnostics.semantic
      ? {
          semantic: {
            similarity:
              diagnostics.semantic.similarity === null
                ? null
                : round(diagnostics.semantic.similarity),
            margin:
              diagnostics.semantic.margin === null
                ? null
                : round(diagnostics.semantic.margin),
            segments: diagnostics.semantic.segments,
            outcome: diagnostics.semantic.outcome,
          },
        }
      : {}),
  };
}
