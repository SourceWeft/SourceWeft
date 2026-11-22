import {
  assertStudyPayloadSize,
  studyContentSchema,
  STUDY_SCHEMA_VERSION,
  type FlashcardItem,
  type QuizItem,
  type StudyContent,
  type StudyEvidence,
  type StudyKind,
} from "@sourceweft/contracts/study";
import {
  citedTextWithin,
  matchesOutputLanguage,
} from "@sourceweft/grounded-generation";
import {
  CHECKPOINT_MAX_BYTES,
  FLASHCARD_VERIFY_EVERY,
  FLASHCARD_VERIFY_MIN,
  generationMaxTokens,
  MAX_ITEMS_PER_CALL,
  OVERGENERATE_FACTOR,
  SINGLE_PASS_MAX_INPUT_TOKENS,
  STUDY_PROMPT_VERSIONS,
  VERIFY_MAX_INPUT_TOKENS,
  VERIFY_MAX_OUTPUT_TOKENS,
} from "./constants";
import {
  allocateGroupQuotas,
  assembleCorpus,
  groupCorpus,
  splitForCallSize,
  StudyInputTooLargeError,
  type CorpusGroup,
} from "./corpus";
import { dedupeItems } from "./dedupe";
import {
  assembleRoot,
  buildGroupForest,
  enforceMindmapLimits,
  groupNodeDepth,
  mergeDuplicateSiblings,
  pruneForest,
  toMindmapNode,
  type WorkNode,
} from "./mindmap";
import {
  buildGenerationPrompt,
  buildOptionVerifyPrompt,
  buildSupportVerifyPrompt,
} from "./prompts";
import { assertRetention, difficultySkewed } from "./quality";
import {
  GENERATION_SCHEMAS,
  optionVerdictsReader,
  supportVerdictReader,
  VERIFY_SCHEMAS,
} from "./schemas";
import { shuffleOptions } from "./shuffle";
import {
  StudyGenerationError,
  type CorpusChunk,
  type DropCounts,
  type FlashcardCandidate,
  type GenerateStudyInput,
  type GroupResult,
  type QuizCandidate,
  type StudyAnchorPort,
  type GenerateStudyDeps,
  type StudyCheckpoint,
  type StudyCheckpointStore,
  type StudyContentResult,
  type StudyModelPort,
  type StudyOperation,
  type StudyProgress,
} from "./types";
import {
  addDrop,
  anchorCandidates,
  hasOutputLanguage,
  mergeDrops,
  parseGroupOutput,
  quizRuleViolation,
  StudyIdAllocator,
} from "./validate";

export type { GenerateStudyDeps };

/** Billing keys: one per group and one per verified item, bound to the version. */
export function generationIdempotencyKey(input: {
  artifactId: string;
  versionNo: number;
  groupIndex: number;
}) {
  return `study:${input.artifactId}:v${input.versionNo}:gen:${input.groupIndex}`;
}

export function verifyIdempotencyKey(input: {
  artifactId: string;
  versionNo: number;
  itemId: string;
}) {
  return `study:${input.artifactId}:v${input.versionNo}:verify:${input.itemId}`;
}

export function studyReferenceId(artifactId: string) {
  return `artifact:${artifactId}`;
}

const GENERATE_OPERATION: Record<StudyKind, StudyOperation> = {
  flashcards: "study.flashcards.generate",
  quiz: "study.quiz.generate",
  mindmap: "study.mindmap.generate",
};

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Study generation was aborted");
  }
}

function checkpointFits(checkpoint: StudyCheckpoint) {
  return (
    new TextEncoder().encode(JSON.stringify(checkpoint)).length <=
    CHECKPOINT_MAX_BYTES
  );
}

/**
 * Generates one study artifact's content from the corpus.
 *
 * Small corpora take one model call; larger ones are split into groups, each
 * generating its share. Every finished group is checkpointed so a retried job
 * continues where it stopped. Then the server-side validation runs: anchoring
 * in the cited chunks, language and quiz rules, duplicate removal, independent
 * verification (every quiz question, a sample of flashcards), option shuffling
 * and the retention gate. Too little surviving fails the whole generation;
 * nothing partial is returned.
 */
export async function generateStudyContent(
  deps: GenerateStudyDeps,
  input: GenerateStudyInput,
): Promise<StudyContentResult> {
  const { kind } = input;
  const progress = async (p: StudyProgress) => {
    await deps.onProgress?.(p);
  };
  throwIfAborted(deps.signal);
  await progress({ stage: "assemble", done: 0, total: 1 });

  if (input.chunks.length === 0) {
    throw new StudyGenerationError(
      "NO_INDEXED_SOURCES",
      "None of the selected sources has indexed text",
    );
  }
  let corpus;
  try {
    corpus = assembleCorpus(input.chunks);
  } catch (error) {
    if (error instanceof StudyInputTooLargeError) {
      throw new StudyGenerationError("INPUT_TOO_LARGE", error.message, {
        totalTokens: error.totalTokens,
      });
    }
    throw error;
  }
  const mode =
    corpus.totalTokens <= SINGLE_PASS_MAX_INPUT_TOKENS ? "single" : "mapreduce";
  const corpusGroups: CorpusGroup[] =
    mode === "single"
      ? [{ index: 0, chunks: corpus.chunks, tokens: corpus.totalTokens }]
      : groupCorpus(corpus.chunks);
  const chunkByHandle = new Map(corpus.chunks.map((chunk) => [chunk.handle, chunk]));

  const requested = input.options.count;
  const target =
    kind === "mindmap" ? requested : Math.ceil(requested * OVERGENERATE_FACTOR);
  const corpusQuotas = allocateGroupQuotas(
    target,
    corpusGroups.map((group) => group.tokens),
  );
  // Cards and questions: no call is asked for more than it answers in time.
  const { groups, quotas } =
    kind === "mindmap"
      ? { groups: corpusGroups, quotas: corpusQuotas }
      : splitForCallSize(corpusGroups, corpusQuotas, MAX_ITEMS_PER_CALL[kind]);

  const ids = new StudyIdAllocator(kind, input.previousIds);
  const loaded = await deps.checkpoint?.load();
  const checkpoint: StudyCheckpoint =
    loaded && loaded.versionNo === input.versionNo
      ? // Written by this engine; the host stores it as opaque JSON.
        (loaded as StudyCheckpoint)
      : { versionNo: input.versionNo, groups: {}, verified: {} };
  for (const result of Object.values(checkpoint.groups)) {
    for (const id of groupItemIds(result)) ids.markUsed(id);
  }
  let checkpointEnabled = true;
  const saveCheckpoint = async () => {
    if (!deps.checkpoint || !checkpointEnabled) return;
    if (!checkpointFits(checkpoint)) {
      // Too big to keep: a retry regenerates under the same billing keys.
      checkpointEnabled = false;
      return;
    }
    await deps.checkpoint.save(checkpoint);
  };

  const dropped: DropCounts = {};
  const results: { group: CorpusGroup; result: GroupResult }[] = [];
  await progress({ stage: "generate", done: 0, total: groups.length });
  for (const [position, group] of groups.entries()) {
    let result = checkpoint.groups[String(group.index)];
    if (!result) {
      throwIfAborted(deps.signal);
      const prompt = buildGenerationPrompt({
        kind,
        chunks: group.chunks,
        count: quotas[position]!,
        difficulty: input.options.difficulty,
        language: input.options.language,
        ...(input.focus ? { focus: input.focus } : {}),
        mindmapDepth: groupNodeDepth(groups.length),
      });
      const raw = await deps.model.completeStructured({
        operation: GENERATE_OPERATION[kind],
        idempotencyKey: generationIdempotencyKey({
          artifactId: input.artifactId,
          versionNo: input.versionNo,
          groupIndex: group.index,
        }),
        referenceId: studyReferenceId(input.artifactId),
        system: prompt.system,
        user: prompt.user,
        schema: GENERATION_SCHEMAS[kind],
        maxTokens: generationMaxTokens(kind, quotas[position]!),
      });
      result = parseGroupOutput({
        kind,
        raw,
        groupHandles: new Set(group.chunks.map((chunk) => chunk.handle)),
        ids,
      });
      checkpoint.groups[String(group.index)] = result;
      await saveCheckpoint();
    }
    mergeDrops(dropped, result.dropped);
    results.push({ group, result });
    await progress({ stage: "generate", done: position + 1, total: groups.length });
  }

  const finish = (
    body:
      | { kind: "flashcards"; items: FlashcardItem[] }
      | { kind: "quiz"; items: QuizItem[] }
      | { kind: "mindmap"; root: ReturnType<typeof toMindmapNode> },
    kept: number,
    difficulties: number[],
  ): StudyContentResult => {
    const skew = difficultySkewed(difficulties);
    const stats = {
      requested,
      kept,
      dropped,
      groups: groups.length,
      tokensEstimated: corpus.totalTokens,
      ...(skew ? { difficultySkew: true } : {}),
    };
    const content = studyContentSchema.parse({
      schemaVersion: STUDY_SCHEMA_VERSION,
      ...body,
      language: input.options.language,
      inputs: input.inputs,
      generation: {
        promptVersion: STUDY_PROMPT_VERSIONS[kind],
        modelAlias: input.modelAlias,
        mode,
        stats,
        recipe: input.recipe,
      },
    } satisfies Record<string, unknown>) as StudyContent;
    // Item counts are capped, so exceeding this is a defect, not user input.
    assertStudyPayloadSize(content);
    return { content, stats, mode };
  };

  if (kind === "mindmap") {
    const groupTrees = results.map(({ result }) => {
      if (result.kind !== "mindmap") throw new Error("Mixed study kinds");
      return { tree: result.tree, forest: buildGroupForest(result.tree) };
    });
    const nodes = groupTrees.flatMap(({ forest }) => flatten(forest));
    await progress({ stage: "verify", done: 0, total: 1 });
    const evidence = await anchorCandidates(
      groupTrees.flatMap(({ tree }) => tree.nodes),
      deps.anchor,
      chunkByHandle,
    );
    for (const node of nodes) node.evidence = evidence.get(node.id) ?? [];
    const generated = nodes.length;
    for (const group of groupTrees) {
      group.forest = mergeDuplicateSiblings(
        pruneForest(
          group.forest,
          (node) =>
            !matchesOutputLanguage(
              `${node.label} ${node.summary ?? ""}`,
              input.options.language,
            )
              ? "wrongLanguage"
              : node.evidence.length > 0
                ? "keep"
                : "unanchored",
          dropped,
        ),
        dropped,
      );
    }
    const root = assembleRoot({
      groups: groupTrees,
      rootLabel: input.rootLabel,
      ids,
    });
    const kept = enforceMindmapLimits(root, requested, dropped);
    await progress({ stage: "verify", done: 1, total: 1 });
    // Node count is a ceiling, not a target: judge retention against what the
    // model could have produced. A map with nothing readable has failed.
    assertRetention({
      kept,
      requested: Math.max(1, Math.min(requested, generated)),
      generated,
      dropped,
    });
    await progress({ stage: "finalize", done: 1, total: 1 });
    return finish({ kind, root: toMindmapNode(root) }, kept, []);
  }

  type Candidate = FlashcardCandidate | QuizCandidate;
  let candidates: Candidate[] = results.flatMap(({ result }) =>
    result.kind === "mindmap" ? [] : (result.items as Candidate[]),
  );

  const generated = candidates.length;
  await progress({ stage: "verify", done: 0, total: candidates.length });
  const evidence = await anchorCandidates(candidates, deps.anchor, chunkByHandle);
  candidates = candidates.filter((item) => {
    if ((evidence.get(item.id)?.length ?? 0) === 0) {
      addDrop(dropped, "unanchored");
      return false;
    }
    if (!hasOutputLanguage(item, input.options.language)) {
      addDrop(dropped, "wrongLanguage");
      return false;
    }
    if (item.kind === "quiz") {
      const violation = quizRuleViolation(item);
      if (violation) {
        addDrop(dropped, violation);
        return false;
      }
    }
    return true;
  });

  const deduped = dedupeItems(candidates, {
    text: (item) => (item.kind === "quiz" ? item.stem : item.front),
    evidence: (item) => evidence.get(item.id)?.length ?? 0,
    difficulty: (item) => item.difficulty,
  });
  addDrop(dropped, "duplicate", deduped.dropped);
  candidates = deduped.kept;

  const kept: Candidate[] = [];
  for (const item of candidates) {
    if (kept.length >= requested) {
      addDrop(dropped, "surplus");
      continue;
    }
    const sampled =
      item.kind === "quiz" ||
      kept.length < FLASHCARD_VERIFY_MIN ||
      kept.length % FLASHCARD_VERIFY_EVERY === 0;
    if (sampled) {
      let verdict = checkpoint.verified[item.id];
      if (!verdict) {
        throwIfAborted(deps.signal);
        verdict = await verifyItem({
          deps,
          input,
          item,
          chunks: (evidence.get(item.id) ?? [])
            .map((entry) => chunkById(corpus.chunks, entry.chunkId))
            .filter((chunk): chunk is CorpusChunk => chunk !== undefined),
        });
        checkpoint.verified[item.id] = verdict;
        await saveCheckpoint();
      }
      if (!verdict.keep) {
        addDrop(dropped, verdict.reason ?? "unanswerable");
        continue;
      }
    }
    kept.push(item);
    await progress({ stage: "verify", done: kept.length, total: requested });
  }

  assertRetention({ kept: kept.length, requested, generated, dropped });
  await progress({ stage: "finalize", done: 1, total: 1 });

  const difficulties = kept.map((item) => item.difficulty);
  if (kind === "flashcards") {
    return finish(
      {
        kind,
        items: (kept as FlashcardCandidate[]).map((item) =>
          toFlashcardItem(item, evidence.get(item.id)!),
        ),
      },
      kept.length,
      difficulties,
    );
  }
  return finish(
    {
      kind: "quiz",
      items: (kept as QuizCandidate[]).map((item) =>
        toQuizItem(item, evidence.get(item.id)!),
      ),
    },
    kept.length,
    difficulties,
  );
}

function flatten(nodes: WorkNode[]): WorkNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function groupItemIds(result: GroupResult): string[] {
  if (result.kind === "mindmap") return result.tree.nodes.map((node) => node.id);
  return result.items.map((item) => item.id);
}

function chunkById(chunks: readonly CorpusChunk[], chunkId: string) {
  return chunks.find((chunk) => chunk.chunkId === chunkId);
}

/**
 * Independent check of one item against only its cited text. Quiz options are
 * judged one by one without the marked answer; the item survives only when the
 * supported set is exactly the marked one.
 */
async function verifyItem(input: {
  deps: GenerateStudyDeps;
  input: GenerateStudyInput;
  item: FlashcardCandidate | QuizCandidate;
  chunks: CorpusChunk[];
}): Promise<{ keep: boolean; reason?: string }> {
  const { item } = input;
  const citedText = citedTextWithin(input.chunks, VERIFY_MAX_INPUT_TOKENS);
  const call = (
    operation: StudyOperation,
    prompt: { system: string; user: string },
    schema: (typeof VERIFY_SCHEMAS)[keyof typeof VERIFY_SCHEMAS],
  ) =>
    input.deps.model.completeStructured({
      operation,
      idempotencyKey: verifyIdempotencyKey({
        artifactId: input.input.artifactId,
        versionNo: input.input.versionNo,
        itemId: item.id,
      }),
      referenceId: studyReferenceId(input.input.artifactId),
      system: prompt.system,
      user: prompt.user,
      schema,
      maxTokens: VERIFY_MAX_OUTPUT_TOKENS,
    });

  if (item.kind === "flashcards" || item.type === "short") {
    const raw = await call(
      item.kind === "flashcards" ? "study.flashcards.verify" : "study.quiz.verify",
      buildSupportVerifyPrompt({
        question: item.kind === "flashcards" ? item.front : item.stem,
        answer:
          item.kind === "flashcards"
            ? item.back
            : (item.referenceAnswer ?? item.explanation),
        citedText,
      }),
      VERIFY_SCHEMAS.support,
    );
    const parsed = supportVerdictReader.safeParse(raw);
    if (!parsed.success) return { keep: false, reason: "verifyFailed" };
    return parsed.data.supported
      ? { keep: true }
      : { keep: false, reason: item.kind === "flashcards" ? "unsupported" : "unanswerable" };
  }

  const raw = await call(
    "study.quiz.verify",
    buildOptionVerifyPrompt({ stem: item.stem, options: item.options, citedText }),
    VERIFY_SCHEMAS.options,
  );
  const parsed = optionVerdictsReader.safeParse(raw);
  if (!parsed.success) return { keep: false, reason: "verifyFailed" };
  return judgeOptionVerdicts(item, parsed.data);
}

/** Compares the per-option verdicts with the marked answer. */
export function judgeOptionVerdicts(
  item: Pick<QuizCandidate, "type" | "options" | "correct">,
  verdicts: { determinable: boolean; verdicts: { option: number; supported: boolean }[] },
): { keep: boolean; reason?: string } {
  if (!verdicts.determinable) return { keep: false, reason: "unanswerable" };
  const supported = new Set(
    verdicts.verdicts
      .filter(
        (verdict) =>
          verdict.supported &&
          verdict.option >= 0 &&
          verdict.option < item.options.length,
      )
      .map((verdict) => verdict.option),
  );
  const correct = new Set(item.correct);
  const same =
    supported.size === correct.size &&
    [...correct].every((index) => supported.has(index));
  if (same) return { keep: true };
  const supersetOfCorrect = [...correct].every((index) => supported.has(index));
  if (
    (item.type !== "multi" && supported.size >= 2) ||
    (item.type === "multi" && supersetOfCorrect && supported.size > correct.size)
  ) {
    return { keep: false, reason: "multiCorrect" };
  }
  return { keep: false, reason: "unanswerable" };
}

function toFlashcardItem(
  item: FlashcardCandidate,
  evidence: StudyEvidence[],
): FlashcardItem {
  return {
    id: item.id,
    fingerprint: item.fingerprint,
    front: item.front,
    back: item.back,
    ...(item.hint ? { hint: item.hint } : {}),
    tags: item.tags,
    difficulty: item.difficulty,
    evidence,
  };
}

function toQuizItem(item: QuizCandidate, evidence: StudyEvidence[]): QuizItem {
  const base = {
    id: item.id,
    fingerprint: item.fingerprint,
    type: item.type,
    stem: item.stem,
    explanation: item.explanation,
    difficulty: item.difficulty,
    evidence,
  };
  if (item.type === "short") {
    return { ...base, referenceAnswer: item.referenceAnswer ?? item.explanation };
  }
  if (item.type === "truefalse") {
    return { ...base, options: item.options, correct: item.correct };
  }
  const shuffled = shuffleOptions(item.options, item.correct, item.id);
  return { ...base, options: shuffled.options, correct: shuffled.correct };
}
