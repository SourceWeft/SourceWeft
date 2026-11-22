"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  readOnlyStudyHost,
  type StudyHost,
  type StudyTranslate,
  type StudyVersionRef,
} from "@sourceweft/builtin-tool-study/ui";
import { contentClient } from "../../../../../lib/sdk";
import { insertIntoComposer } from "../chat-canvas/composer-insert";
import { requestStudyRegenerate } from "../study-generate/study-regenerate-store";
import { openGroundedEvidenceSource } from "./grounded-evidence-source";

const NAMESPACE = "study";

/**
 * Backs the viewers' `study.*` keys with the app's catalog (all three
 * locales). The namespace is passed as a literal so the per-route message
 * subsets (`i18n/client-messages.ts`) can see which routes need it.
 */
export function useStudyTranslate(): StudyTranslate {
  const t = useTranslations("study");
  return useCallback(
    (key, values) =>
      t(
        (key.startsWith(`${NAMESPACE}.`)
          ? key.slice(NAMESPACE.length + 1)
          : key) as Parameters<typeof t>[0],
        values,
      ),
    [t],
  );
}

/** The learning-state API names a version by its id; a viewer may not know it yet. */
function versionQuery(ref: StudyVersionRef) {
  return ref.artifactVersionId ? { artifactVersionId: ref.artifactVersionId } : {};
}

function requireVersionId(ref: StudyVersionRef): string {
  if (!ref.artifactVersionId) {
    throw new Error("This study artifact has no version to record against");
  }
  return ref.artifactVersionId;
}

/** Version numbers by version id: attempts are listed by number, viewers know the id. */
const versionNos = new Map<string, number>();

async function resolveVersionNo(ref: StudyVersionRef): Promise<number> {
  const known = ref.artifactVersionId ? versionNos.get(ref.artifactVersionId) : undefined;
  if (known !== undefined) return known;
  const progress = await contentClient.getStudyReviewProgress(
    ref.workspaceId,
    ref.artifactId,
    versionQuery(ref),
  );
  versionNos.set(progress.artifactVersionId, progress.versionNo);
  return progress.versionNo;
}

/**
 * The app's side of the study viewers: the signed-in learning-state API
 * (review progress and grades, quiz attempts), the source preview for
 * evidence, the chat composer for "ask in chat" (filled, never sent),
 * freshness, and regeneration through the generate dialog pre-filled from
 * the recipe (`StudyRegenerateDialogHost`, mounted next to every
 * capability-owned preview). Checking a quote against the current source text
 * is not available yet, so each quote shows as stored.
 */
export const webStudyHost: StudyHost = {
  interactive: true,
  useTranslate: useStudyTranslate,
  async listReviewProgress(ref) {
    const progress = await contentClient.getStudyReviewProgress(
      ref.workspaceId,
      ref.artifactId,
      versionQuery(ref),
    );
    versionNos.set(progress.artifactVersionId, progress.versionNo);
    return progress.items;
  },
  gradeCard: async ({ workspaceId, artifactId, itemId, grade, ...ref }) =>
    contentClient.gradeStudyCard(workspaceId, artifactId, {
      artifactVersionId: requireVersionId({ workspaceId, artifactId, ...ref }),
      itemId,
      grade,
    }),
  async latestQuizAttempt(ref) {
    const [versionNo, attempts] = await Promise.all([
      resolveVersionNo(ref),
      contentClient.listStudyQuizAttempts(ref.workspaceId, ref.artifactId),
    ]);
    // Newest first.
    return attempts.items.find((attempt) => attempt.versionNo === versionNo) ?? null;
  },
  startQuizAttempt: async ({ workspaceId, artifactId, itemIds, ...ref }) =>
    contentClient.startStudyQuizAttempt(workspaceId, artifactId, {
      artifactVersionId: requireVersionId({ workspaceId, artifactId, ...ref }),
      ...(itemIds && itemIds.length > 0 ? { itemIds: [...itemIds] } : {}),
    }),
  saveQuizAnswers: ({ workspaceId, attemptId, answers, finish }) =>
    contentClient.saveStudyQuizAnswers(workspaceId, attemptId, {
      answers: { ...answers },
      ...(finish ? { finish: true } : {}),
    }),
  openEvidence: openGroundedEvidenceSource,
  currentQuoteHash: () =>
    Promise.reject(new Error("Checking a quote against its source is not available yet")),
  askInChat: ({ text }) => {
    insertIntoComposer(text);
  },
  downloadText: readOnlyStudyHost.downloadText,
  getFreshness: async (ref) => {
    const freshness = await contentClient.getStudyFreshness(ref.workspaceId, ref.artifactId);
    return { status: freshness.state };
  },
  requestRegenerate: requestStudyRegenerate,
};
