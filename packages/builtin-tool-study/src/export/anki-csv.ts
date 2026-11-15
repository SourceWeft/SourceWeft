import type { StudyContent, StudyEvidence } from "@sourceweft/contracts/study";

type FlashcardsContent = Extract<StudyContent, { kind: "flashcards" }>;

export type ExportFlashcardsCsvOptions = {
  /** Display titles by `sourceId`; a source without one is named by its heading path. */
  readonly sourceTitles?: Readonly<Record<string, string>>;
};

/** RFC 4180 field: quoted when it holds a separator, quote or line break. */
function csvField(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function evidenceLabel(
  evidence: StudyEvidence,
  sourceTitles: Readonly<Record<string, string>>,
) {
  const title = sourceTitles[evidence.sourceId];
  const place = [title, evidence.headingPath].filter(Boolean).join(" › ");
  return place ? `${place}: “${evidence.quote}”` : `“${evidence.quote}”`;
}

/**
 * Flashcards as an Anki-importable CSV: front, back, source (title, heading and
 * quote of every piece of evidence) and tags. The `#` header lines are Anki's
 * file headers, so the import dialog needs no manual column mapping.
 */
export function exportFlashcardsCsv(
  content: FlashcardsContent,
  options: ExportFlashcardsCsvOptions = {},
): string {
  const sourceTitles = options.sourceTitles ?? {};
  const header = [
    "#separator:comma",
    "#html:false",
    "#columns:Front,Back,Source,Tags",
    "#tags column:4",
  ];
  const rows = content.items.map((item) =>
    [
      item.front,
      item.back,
      item.evidence
        .map((evidence) => evidenceLabel(evidence, sourceTitles))
        .join("\n"),
      // Anki separates tags by spaces, so a space inside one tag would split it.
      item.tags.map((tag) => tag.trim().replace(/\s+/g, "_")).join(" "),
    ]
      .map(csvField)
      .join(","),
  );
  return `${[...header, ...rows].join("\n")}\n`;
}
