import {
  flashcardItemSchema,
  newStudyItemId,
  quizItemSchema,
  STUDY_LIMITS,
  STUDY_TRUEFALSE_OPTIONS,
  studyFingerprint,
  type StudyEvidence,
  type StudyKind,
} from "@sourceweft/contracts/study";
import {
  anchorCandidates as anchorItems,
  estimateTokens,
  evidenceFrom,
  locateQuote,
  matchesOutputLanguage,
} from "@sourceweft/grounded-generation";
import { LEAK_LENGTH_RATIO, QUOTE_MAX_CHARS, QUOTE_MIN_TOKENS } from "./constants";
import { normalizeForCompare } from "./dedupe";
import {
  flashcardsOutputReader,
  mindmapOutputReader,
  quizOutputReader,
  rawFlashcardReader,
  rawMindmapNodeReader,
  rawQuizReader,
} from "./schemas";
import type {
  CorpusChunk,
  DropCounts,
  FlashcardCandidate,
  GroupResult,
  MindmapCandidate,
  QuizCandidate,
  StudyAnchorPort,
} from "./types";

export function addDrop(dropped: DropCounts, reason: string, by = 1) {
  if (by <= 0) return;
  dropped[reason] = (dropped[reason] ?? 0) + by;
}

export function mergeDrops(target: DropCounts, source: DropCounts) {
  for (const [reason, count] of Object.entries(source)) {
    addDrop(target, reason, count);
  }
}

/**
 * Hands out item ids: an item whose fingerprint matches one of the previous
 * version's keeps that id (once); everything else gets a fresh one. Ids
 * already taken (for example by a checkpointed group) are never reused.
 */
export class StudyIdAllocator {
  private readonly used = new Set<string>();

  constructor(
    private readonly kind: StudyKind,
    private readonly previousIds: ReadonlyMap<string, string> = new Map(),
  ) {}

  markUsed(id: string) {
    this.used.add(id);
  }

  allocate(fingerprint: string): string {
    const previous = this.previousIds.get(fingerprint);
    if (previous && !this.used.has(previous)) {
      this.used.add(previous);
      return previous;
    }
    let id = newStudyItemId(this.kind);
    while (this.used.has(id)) id = newStudyItemId(this.kind);
    this.used.add(id);
    return id;
  }
}

/** Valid, unique handles of this group, at most three; null when none. */
function resolveRefs(
  refs: readonly string[],
  groupHandles: ReadonlySet<string>,
): string[] | null {
  const valid = [
    ...new Set(refs.map((ref) => ref.trim()).filter((ref) => groupHandles.has(ref))),
  ].slice(0, STUDY_LIMITS.evidencePerItem);
  return valid.length > 0 ? valid : null;
}

/** A stand-in that lets the contract's item schema check everything else. */
const PLACEHOLDER_EVIDENCE: StudyEvidence = {
  kind: "chunk",
  sourceId: "s",
  documentId: "d",
  chunkId: "c",
  quote: "q",
  quoteHash: `sha256:${"0".repeat(64)}`,
};

function cleanTags(tags: readonly string[]) {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0 && tag.length <= 40),
    ),
  ].slice(0, 8);
}

function nullIfBlank(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Turns one group's raw model answer into candidates: unreadable items count
 * as `schema`, items citing no chunk of this group as `badRef`. A top-level
 * answer that cannot be read at all yields no candidates (`malformedOutput`).
 */
export function parseGroupOutput(input: {
  kind: StudyKind;
  raw: unknown;
  groupHandles: ReadonlySet<string>;
  ids: StudyIdAllocator;
}): GroupResult {
  const dropped: DropCounts = {};
  const { kind, raw, groupHandles, ids } = input;

  if (kind === "flashcards") {
    const top = flashcardsOutputReader.safeParse(raw);
    if (!top.success) {
      addDrop(dropped, "malformedOutput");
      return { kind, items: [], dropped };
    }
    const items: FlashcardCandidate[] = [];
    for (const value of top.data.cards) {
      const parsed = rawFlashcardReader.safeParse(value);
      if (!parsed.success) {
        addDrop(dropped, "schema");
        continue;
      }
      const card = parsed.data;
      const candidate = {
        front: card.front,
        back: card.back,
        hint: nullIfBlank(card.hint),
        tags: cleanTags(card.tags),
        difficulty: card.difficulty,
      };
      const fingerprint = studyFingerprint("flashcards", candidate.front);
      const check = flashcardItemSchema.safeParse({
        ...candidate,
        id: "c_check",
        fingerprint,
        evidence: [PLACEHOLDER_EVIDENCE],
      });
      if (!check.success) {
        addDrop(dropped, "schema");
        continue;
      }
      const refs = resolveRefs(card.refs, groupHandles);
      if (!refs) {
        addDrop(dropped, "badRef");
        continue;
      }
      items.push({
        kind,
        id: ids.allocate(fingerprint),
        fingerprint,
        ...candidate,
        refs,
        quote: nullIfBlank(card.quote),
      });
    }
    return { kind, items, dropped };
  }

  if (kind === "quiz") {
    const top = quizOutputReader.safeParse(raw);
    if (!top.success) {
      addDrop(dropped, "malformedOutput");
      return { kind, items: [], dropped };
    }
    const items: QuizCandidate[] = [];
    for (const value of top.data.questions) {
      const parsed = rawQuizReader.safeParse(value);
      if (!parsed.success) {
        addDrop(dropped, "schema");
        continue;
      }
      const question = parsed.data;
      let options = question.options.map((option) => option.trim());
      let correct = [...question.correct];
      if (question.type === "truefalse") {
        const lowered = options.map((option) => option.toLowerCase());
        const fixed =
          lowered.length === 2 &&
          lowered[0] === STUDY_TRUEFALSE_OPTIONS[0] &&
          lowered[1] === STUDY_TRUEFALSE_OPTIONS[1];
        if (!fixed) {
          addDrop(dropped, "schema");
          continue;
        }
        options = [...STUDY_TRUEFALSE_OPTIONS];
      }
      if (question.type === "short") {
        options = [];
        correct = [];
      }
      correct = [...new Set(correct)].sort((a, b) => a - b);
      const candidate = {
        type: question.type,
        stem: question.stem,
        options,
        correct,
        referenceAnswer:
          question.type === "short" ? nullIfBlank(question.referenceAnswer) : null,
        explanation: question.explanation,
        difficulty: question.difficulty,
      };
      const fingerprint = studyFingerprint("quiz", candidate.stem);
      const check = quizItemSchema.safeParse({
        id: "q_check",
        fingerprint,
        type: candidate.type,
        stem: candidate.stem,
        ...(candidate.type === "short"
          ? { referenceAnswer: candidate.referenceAnswer ?? undefined }
          : { options: candidate.options, correct: candidate.correct }),
        explanation: candidate.explanation,
        difficulty: candidate.difficulty,
        evidence: [PLACEHOLDER_EVIDENCE],
      });
      if (!check.success) {
        addDrop(dropped, "schema");
        continue;
      }
      const refs = resolveRefs(question.refs, groupHandles);
      if (!refs) {
        addDrop(dropped, "badRef");
        continue;
      }
      items.push({
        kind,
        id: ids.allocate(fingerprint),
        fingerprint,
        ...candidate,
        refs,
        quote: nullIfBlank(question.quote),
      });
    }
    return { kind, items, dropped };
  }

  const top = mindmapOutputReader.safeParse(raw);
  if (!top.success || !top.data.rootLabel.trim()) {
    addDrop(dropped, "malformedOutput");
    return {
      kind,
      tree: { rootLabel: "", rootSummary: null, nodes: [] },
      dropped,
    };
  }
  const nodes: MindmapCandidate[] = [];
  const keys = new Set<string>();
  for (const value of top.data.nodes) {
    const parsed = rawMindmapNodeReader.safeParse(value);
    if (!parsed.success || keys.has(parsed.data.key)) {
      addDrop(dropped, "schema");
      continue;
    }
    const node = parsed.data;
    const parentKey = nullIfBlank(node.parentKey);
    // Parents come first; a node whose parent is unknown cannot be placed.
    if (parentKey !== null && !keys.has(parentKey)) {
      addDrop(dropped, "badParent");
      continue;
    }
    const label = truncate(node.label, STUDY_LIMITS.mindmapLabelChars);
    const summary = nullIfBlank(node.summary);
    const refs = resolveRefs(node.refs, groupHandles) ?? [];
    const fingerprint = studyFingerprint("mindmap", label);
    keys.add(node.key);
    nodes.push({
      kind,
      id: ids.allocate(fingerprint),
      fingerprint,
      key: node.key,
      parentKey,
      label,
      summary: summary
        ? truncate(summary, STUDY_LIMITS.mindmapSummaryChars)
        : null,
      refs,
      quote: nullIfBlank(node.quote),
    });
  }
  return {
    kind,
    tree: {
      rootLabel: truncate(top.data.rootLabel.trim(), STUDY_LIMITS.mindmapLabelChars),
      rootSummary: nullIfBlank(top.data.rootSummary)
        ? truncate(top.data.rootSummary!.trim(), STUDY_LIMITS.mindmapSummaryChars)
        : null,
      nodes,
    },
    dropped,
  };
}

function truncate(text: string, max: number) {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** The generated text that has to be found in the cited source. */
export function supportText(
  item: FlashcardCandidate | QuizCandidate | MindmapCandidate,
): string {
  if (item.kind === "flashcards") return item.back;
  if (item.kind === "mindmap") return item.summary ?? item.label;
  if (item.type === "short") {
    return [item.referenceAnswer, item.explanation].filter(Boolean).join(" ");
  }
  if (item.type === "truefalse") {
    return item.correct[0] === 0
      ? `${item.stem} ${item.explanation}`
      : item.explanation;
  }
  const answers = item.correct.map((index) => item.options[index]).join("; ");
  return `${answers}. ${item.explanation}`;
}

/** All learner-facing text of an item, for the language check. */
export function itemText(
  item: FlashcardCandidate | QuizCandidate | MindmapCandidate,
): string {
  if (item.kind === "flashcards") return `${item.front} ${item.back}`;
  if (item.kind === "mindmap") return `${item.label} ${item.summary ?? ""}`;
  const options =
    item.type === "single" || item.type === "multi" ? item.options.join(" ") : "";
  return `${item.stem} ${options} ${item.referenceAnswer ?? ""} ${item.explanation}`;
}

export function hasOutputLanguage(
  item: FlashcardCandidate | QuizCandidate | MindmapCandidate,
  language: string,
) {
  return matchesOutputLanguage(itemText(item), language);
}

const ALL_OR_NONE =
  /\b(all|none|both|neither) of the (above|options|choices)\b|以上(皆是|都是|全是|均是|皆非|都不是|全不是|均不是|都对|都不对|全对|全错|都正确|都不正确)|上述(都|皆|均)/i;

/**
 * Deterministic quiz rules: no "all/none of the above", no repeated options,
 * and no correct option that gives itself away by being much longer.
 */
export function quizRuleViolation(item: QuizCandidate): string | null {
  if (item.type !== "single" && item.type !== "multi") return null;
  if (item.options.some((option) => ALL_OR_NONE.test(option))) {
    return "allOfAbove";
  }
  const normalized = item.options.map(normalizeForCompare);
  if (new Set(normalized).size !== normalized.length) {
    return "duplicateOptions";
  }
  const correct = new Set(item.correct);
  const lengthOf = (option: string) => [...option].length;
  const right = item.options.filter((_, index) => correct.has(index));
  const wrong = item.options.filter((_, index) => !correct.has(index));
  if (wrong.length === 0) return null;
  const mean = (values: string[]) =>
    values.reduce((sum, value) => sum + lengthOf(value), 0) / values.length;
  if (mean(right) > mean(wrong) * LEAK_LENGTH_RATIO) return "leak";
  return null;
}

/**
 * The item's own quote as evidence, when a chunk it cites holds it word for
 * word: the chunk's text at that span. Null for a missing, too short or
 * reworded quote. A quote proves the passage exists in any language, so it
 * carries items written in another language than their source.
 */
export function quotedEvidence(
  item: FlashcardCandidate | QuizCandidate | MindmapCandidate,
  chunkByHandle: ReadonlyMap<string, CorpusChunk>,
): StudyEvidence | null {
  const quote = item.quote?.trim();
  if (!quote || estimateTokens(quote) < QUOTE_MIN_TOKENS) return null;
  for (const ref of item.refs) {
    const chunk = chunkByHandle.get(ref);
    if (!chunk) continue;
    const span = locateQuote(chunk.text, quote);
    if (!span) continue;
    return evidenceFrom(
      chunk,
      { ...span, quote: chunk.text.slice(span.startChar, span.endChar), confidence: 1 },
      QUOTE_MAX_CHARS,
    );
  }
  return null;
}

/**
 * Evidence for every candidate. An item whose quote a cited chunk holds word
 * for word takes that passage; the rest have their supporting text anchored
 * in each chunk they cite, in one batch. Returns the evidence per item id; an
 * item absent from the map was not supported by any of its chunks.
 */
export async function anchorCandidates(
  items: readonly (FlashcardCandidate | QuizCandidate | MindmapCandidate)[],
  anchorPort: StudyAnchorPort,
  chunkByHandle: ReadonlyMap<string, CorpusChunk>,
): Promise<Map<string, StudyEvidence[]>> {
  const evidence = new Map<string, StudyEvidence[]>();
  const rest: (FlashcardCandidate | QuizCandidate | MindmapCandidate)[] = [];
  for (const item of items) {
    const quoted = quotedEvidence(item, chunkByHandle);
    if (quoted) evidence.set(item.id, [quoted]);
    else rest.push(item);
  }
  const anchored = await anchorItems(
    rest.map((item) => ({
      id: item.id,
      refs: item.refs,
      text: supportText(item),
    })),
    anchorPort,
    chunkByHandle,
    { evidencePerItem: STUDY_LIMITS.evidencePerItem, quoteChars: QUOTE_MAX_CHARS },
  );
  for (const [id, list] of anchored) evidence.set(id, list);
  return evidence;
}
