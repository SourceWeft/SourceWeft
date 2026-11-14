/**
 * An answer's `[citation:key]` markers only mean something inside the message
 * that holds the citations. A saved note must stand alone, so the markers
 * become numbered footnotes and the sources they pointed at are listed under
 * the text, each with the passage that supported the claim.
 */

export type NoteCitationInput = {
  citation: string;
  sourceId: string | null;
  sourceTitle?: string;
  chunkId?: string;
  externalUri?: string;
  excerpt?: string;
  /** The supporting passage, when the citation was anchored (#472). */
  spanText?: string;
};

export type NoteReference = {
  number: number;
  citation: string;
  sourceId: string | null;
  sourceTitle: string | null;
  chunkId: string | null;
  externalUri: string | null;
  /** What supported the claim: the anchored passage, else the excerpt. */
  passage: string | null;
};

const MARKER =
  /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;
const CJK = /[㐀-䶿一-鿿]/;
const PASSAGE_LIMIT = 280;

function passageOf(citation: NoteCitationInput) {
  const text = (citation.spanText || citation.excerpt || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > PASSAGE_LIMIT
    ? `${text.slice(0, PASSAGE_LIMIT).trimEnd()}…`
    : text;
}

export function rewriteCitationsForNote(input: {
  content: string;
  citations: readonly NoteCitationInput[];
}) {
  const byKey = new Map(input.citations.map((item) => [item.citation, item]));
  const numbers = new Map<string, number>();
  const references: NoteReference[] = [];

  const text = input.content.replace(MARKER, (_marker, ids: string) => {
    const used: number[] = [];
    for (const id of ids.split(",").map((part) => part.trim())) {
      const citation = byKey.get(id);
      // A marker that matches no citation of the message is dropped rather
      // than left behind as a dangling key.
      if (!citation) continue;
      let number = numbers.get(id);
      if (number === undefined) {
        number = references.length + 1;
        numbers.set(id, number);
        references.push({
          number,
          citation: id,
          sourceId: citation.sourceId,
          sourceTitle: citation.sourceTitle ?? null,
          chunkId: citation.chunkId ?? null,
          externalUri: citation.externalUri ?? null,
          passage: passageOf(citation),
        });
      }
      if (!used.includes(number)) used.push(number);
    }
    return used.length > 0 ? used.map((n) => `[${n}]`).join("") : "";
  });

  const body = text.replace(/[ \t]+([，。,.;；])/g, "$1").trimEnd();
  if (references.length === 0) return { text: body, references };

  const heading = CJK.test(input.content) ? "参考来源" : "Sources";
  const lines = references.map((reference) => {
    const label =
      reference.sourceTitle ?? reference.externalUri ?? reference.citation;
    return reference.passage
      ? `[${reference.number}] ${label}: "${reference.passage}"`
      : `[${reference.number}] ${label}`;
  });
  return {
    text: `${body}\n\n---\n\n${heading}\n\n${lines.join("\n\n")}\n`,
    references,
  };
}
