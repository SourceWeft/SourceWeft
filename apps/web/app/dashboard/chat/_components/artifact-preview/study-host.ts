"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  readOnlyStudyHost,
  type StudyHost,
  type StudyTranslate,
  type StudyVersionRef,
} from "@sourceweft/builtin-tool-study/ui";
import { useBillingAvailable } from "@/lib/billing-edition/capabilities";
import { usePurchasesAllowed } from "@/lib/native-host";
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

/** Billing, where this deployment and the host the page runs in may sell credits. */
function useStudyBillingLink() {
  const t = useTranslations("study");
  const billingAvailable = useBillingAvailable();
  const purchasesAllowed = usePurchasesAllowed();
  return billingAvailable && purchasesAllowed
    ? { href: "/dashboard/billing", label: t("generate.manageBilling") }
    : null;
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
  useBillingLink: useStudyBillingLink,
  async listReviewProgress(ref) {
    const progress = await contentClient.getStudyReviewProgress(
      ref.workspaceId,
      ref.artifactId,
      versionQuery(ref),
    );
    return progress.items;
  },
  gradeCard: async ({ workspaceId, artifactId, itemId, grade, ...ref }) =>
    contentClient.gradeStudyCard(workspaceId, artifactId, {
      artifactVersionId: requireVersionId({ workspaceId, artifactId, ...ref }),
      itemId,
      grade,
    }),
  async latestQuizAttempt(ref) {
    // Only the version shown: an attempt at another version names questions
    // this one may not have. Newest first.
    const attempts = await contentClient.listStudyQuizAttempts(ref.workspaceId, ref.artifactId, {
      artifactVersionId: requireVersionId(ref),
    });
    return attempts.items[0] ?? null;
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
  async deriveCardsFromMistakes({ workspaceId, attemptId }) {
    const deck = await contentClient.deriveStudyCardsFromAttempt(workspaceId, attemptId);
    return { artifactId: deck.artifactId, versionId: deck.versionId, itemCount: deck.itemCount };
  },
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
