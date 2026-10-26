"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { ArtifactStorageText } from "@sourceweft/contracts/artifact-storage-text";

/** The artifact storage prompts in the viewer's language. */
export function useArtifactStorageText(): ArtifactStorageText {
  const t = useTranslations("artifactShare.storage");
  // Raw, not formatted: the package fills `{author}`-style placeholders itself
  // and the catalog keeps `<strong>` as plain markers.
  // Stable per locale: callers key memoised preview contexts on this object.
  return useMemo(
    () => ({
      linkTitle: t.raw("linkTitle"),
      linkIntro: t.raw("linkIntro"),
      linkShownAs: t.raw("linkShownAs"),
      linkShowAll: t.raw("linkShowAll"),
      linkLongWarning: t.raw("linkLongWarning"),
      cancel: t.raw("cancel"),
      continue: t.raw("continue"),
      navigatedAway: t.raw("navigatedAway"),
      reloadPage: t.raw("reloadPage"),
      navigationAttemptsOne: t.raw("navigationAttemptsOne"),
      navigationAttemptsOther: t.raw("navigationAttemptsOther"),
      ownData: t.raw("ownData"),
      statusError: t.raw("statusError"),
      actionError: t.raw("actionError"),
      memberFallback: t.raw("memberFallback"),
      approvalRegionLabel: t.raw("approvalRegionLabel"),
      waitingForYourApproval: t.raw("waitingForYourApproval"),
      waitingForApproval: t.raw("waitingForApproval"),
      approvalAsk: t.raw("approvalAsk"),
      approverHint: t.raw("approverHint"),
      nonApproverHint: t.raw("nonApproverHint"),
      reviewRequest: t.raw("reviewRequest"),
      reviewBody: t.raw("reviewBody"),
      approveVersion: t.raw("approveVersion"),
      consentRegionLabel: t.raw("consentRegionLabel"),
      consentBody: t.raw("consentBody"),
      consentMeta: t.raw("consentMeta"),
      allowSharedData: t.raw("allowSharedData"),
      sharedDataOn: t.raw("sharedDataOn"),
      revokeApproval: t.raw("revokeApproval"),
    }),
    [t],
  );
}
