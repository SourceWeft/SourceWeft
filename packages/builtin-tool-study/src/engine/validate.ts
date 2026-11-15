import { createHash } from "node:crypto";
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
import { LEAK_LENGTH_RATIO, QUOTE_MAX_CHARS } from "./constants";
import { isCjkChar } from "./corpus";
import { normalizeForCompare } from "./dedupe";
import { matchesOutputLanguage } from "./language";
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
  StudyAnchorResult,
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

export function quoteHash(quote: string) {
  return `sha256:${createHash("sha256").update(quote, "utf8").digest("hex")}`;
}

export function evidenceFrom(
  chunk: CorpusChunk,
  anchor: StudyAnchorResult,
): StudyEvidence {
  let { startChar, endChar, quote } = anchor;
  if ([...quote].length > QUOTE_MAX_CHARS) {
    quote = [...quote].slice(0, QUOTE_MAX_CHARS).join("");
    endChar = startChar + quote.length;
  }
  return {
    kind: "chunk",
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    chunkNo: chunk.chunkNo,
    headingPath: chunk.headingPath,
    quote,
    startChar,
    endChar,
    quoteHash: quoteHash(quote),
  };
}

/**
 * Anchors every candidate's supporting text in each chunk it cites, in one
 * batch. Returns the evidence per item id; an item absent from the map was
 * not supported by any of its chunks.
 */
export async function anchorCandidates(
  items: readonly (FlashcardCandidate | QuizCandidate | MindmapCandidate)[],
  anchorPort: StudyAnchorPort,
  chunkByHandle: ReadonlyMap<string, CorpusChunk>,
): Promise<Map<string, StudyEvidence[]>> {
  const requests: { itemId: string; chunk: CorpusChunk; text: string }[] = [];
  for (const item of items) {
    const text = supportText(item);
    for (const ref of item.refs) {
      const chunk = chunkByHandle.get(ref);
      if (chunk) requests.push({ itemId: item.id, chunk, text });
    }
  }
  const evidence = new Map<string, StudyEvidence[]>();
  if (requests.length === 0) return evidence;
  const results = await anchorPort.anchor(
    requests.map((request) => ({
      text: request.text,
      chunkId: request.chunk.chunkId,
      chunkContent: request.chunk.text,
    })),
  );
  requests.forEach((request, index) => {
    const result = results[index];
    if (!result || result.quote.trim().length === 0) return;
    const list = evidence.get(request.itemId) ?? [];
    if (list.length < STUDY_LIMITS.evidencePerItem) {
      list.push(evidenceFrom(request.chunk, result));
    }
    evidence.set(request.itemId, list);
  });
  return evidence;
}

/** Cited chunk text for a verification call, cut to the token budget. */
export function citedTextWithin(
  chunks: readonly CorpusChunk[],
  budgetTokens: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const remaining = budgetTokens - used;
    if (remaining <= 0) break;
    if (chunk.tokens <= remaining) {
      parts.push(chunk.text);
      used += chunk.tokens;
      continue;
    }
    let cut = "";
    let tokens = 0;
    let pendingOther = 0;
    for (const char of chunk.text) {
      // Same arithmetic as estimateTokens, kept incremental.
      const isCjk = isCjkChar(char);
      const next = isCjk ? tokens + 1 : tokens + (pendingOther % 4 === 0 ? 1 : 0);
      if (next > remaining) break;
      if (!isCjk) pendingOther += 1;
      tokens = next;
      cut += char;
    }
    if (cut) parts.push(cut);
    break;
  }
  return parts.join("\n\n");
}
