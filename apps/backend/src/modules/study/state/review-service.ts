import {
  parseStudyContentForArtifact,
  type ReviewGrade,
  type ReviewProgressResponse,
  type ReviewQueueItem,
  type ReviewQueueResponse,
  type ReviewState,
} from "@sourceweft/contracts/study";
import { ContentError } from "../../content/errors";
import { canViewContent } from "../../workspace/content-visibility";
import { requireStudyVersion, requireWorkspaceMember } from "./access";
import { loadStudyScheduling } from "../capability";
import {
  findReadyStudyArtifactVersion,
  gradeReviewItem,
  listDueReviewItems,
  listReviewStates,
  listStudiedDeckIds,
  type ReviewStateRow,
} from "./repository";

export const REVIEW_QUEUE_MAX = 50;
/** Decks scanned for new cards when the queue is not narrowed to one deck. */
const NEW_CARD_DECKS_MAX = 10;

type Clock = { now?: () => Date };
const systemNow = () => new Date();

function reviewStateView(row: ReviewStateRow): ReviewState {
  return {
    itemId: row.itemId,
    state: row.state as ReviewState["state"],
    dueAt: row.dueAt.toISOString(),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
  };
}

/**
 * Grades one flashcard of one version. The item must exist in that version, so
 * a client cannot mint state for an id the deck never had.
 */
export async function gradeFlashcard(
  input: {
    workspaceId: string;
    userId: string;
    artifactId: string;
    /** Exactly one of these names the version. */
    versionNo?: number;
    artifactVersionId?: string;
    itemId: string;
    grade: ReviewGrade;
  },
  clock: Clock = {},
): Promise<ReviewState> {
  const version = await requireStudyVersion({
    ...input,
    artifactType: "flashcards",
  });
  if (!version.content.items.some((item) => item.id === input.itemId)) {
    throw new ContentError(
      400,
      "STUDY_ITEM_NOT_IN_VERSION",
      "This card is not part of that version",
    );
  }
  const scheduling = await loadStudyScheduling();
  const row = await gradeReviewItem({
    owner: version.owner,
    itemId: input.itemId,
    versionNo: version.versionNo,
    now: (clock.now ?? systemNow)(),
    schedule: (card, now) => scheduling.scheduleReview(card, input.grade, now),
  });
  return reviewStateView(row);
}

/** The caller's state for each graded card of one version (current by default). */
export async function getReviewProgress(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
  versionNo?: number;
  artifactVersionId?: string;
}): Promise<ReviewProgressResponse> {
  const version = await requireStudyVersion({
    ...input,
    artifactType: "flashcards",
  });
  const rows = await listReviewStates({
    userId: input.userId,
    artifactId: version.owner.artifactId,
    itemIds: version.content.items.map((item) => item.id),
  });
  return {
    artifactId: version.owner.artifactId,
    artifactVersionId: version.versionId,
    versionNo: version.versionNo,
    items: Object.fromEntries(
      rows.map((row) => [row.itemId, reviewStateView(row)]),
    ),
  };
}

/**
 * Cards to review now: due cards oldest first, then never-graded cards of the
 * decks the user is studying (or of the named deck) to fill up to `limit`.
 */
export async function getReviewQueue(
  input: {
    workspaceId: string;
    userId: string;
    artifactId?: string;
    limit?: number;
  },
  clock: Clock = {},
): Promise<ReviewQueueResponse> {
  const access = await requireWorkspaceMember(input);
  const limit = Math.min(input.limit ?? REVIEW_QUEUE_MAX, REVIEW_QUEUE_MAX);
  const now = (clock.now ?? systemNow)();
  if (input.artifactId) {
    // Same 404 as every other route for a deck the caller cannot see.
    await requireStudyVersion({
      workspaceId: input.workspaceId,
      userId: input.userId,
      artifactId: input.artifactId,
      artifactType: "flashcards",
    });
  }

  const due = await listDueReviewItems({
    userId: input.userId,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    now,
    limit,
  });
  const items: ReviewQueueItem[] = due.map((row) => ({
    artifactId: row.artifactId,
    versionNo: row.versionNo,
    itemId: row.itemId,
    state: row.state as ReviewQueueItem["state"],
    dueAt: row.dueAt.toISOString(),
  }));

  const deckIds = input.artifactId
    ? [input.artifactId]
    : await listStudiedDeckIds({
        userId: input.userId,
        workspaceId: input.workspaceId,
        limit: NEW_CARD_DECKS_MAX,
      });
  for (const deckId of deckIds) {
    if (items.length >= limit) break;
    const deck = await findReadyStudyArtifactVersion({
      teamId: access.organizationId,
      workspaceId: input.workspaceId,
      artifactId: deckId,
    });
    if (
      !deck ||
      deck.artifactType !== "flashcards" ||
      !canViewContent(input.userId, deck)
    ) {
      continue;
    }
    let itemIds: string[];
    try {
      const content = parseStudyContentForArtifact("flashcards", deck.contentJson);
      if (content.kind !== "flashcards") continue;
      itemIds = content.items.map((item) => item.id);
    } catch {
      continue;
    }
    const graded = new Set(
      (
        await listReviewStates({
          userId: input.userId,
          artifactId: deckId,
          itemIds,
        })
      ).map((row) => row.itemId),
    );
    for (const itemId of itemIds) {
      if (items.length >= limit) break;
      if (graded.has(itemId)) continue;
      items.push({
        artifactId: deckId,
        versionNo: deck.versionNo,
        itemId,
        state: 0,
        dueAt: now.toISOString(),
      });
    }
  }
  return { items };
}
