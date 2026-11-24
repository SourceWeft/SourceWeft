"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  browserDownload,
  type TableHost,
  type TableTranslate,
} from "@sourceweft/builtin-tool-table/ui";
import { contentClient } from "../../../../../lib/sdk";
import { requestTableRegenerate } from "../table-generate/table-regenerate-store";
import { openGroundedEvidenceSource } from "./grounded-evidence-source";

const NAMESPACE = "table";

/**
 * Backs the viewer's `table.*` keys with the app's catalog (all three
 * locales). The namespace is passed as a literal so the per-route message
 * subsets (`i18n/client-messages.ts`) can see which routes need it.
 */
export function useTableTranslate(): TableTranslate {
  const t = useTranslations("table");
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

/**
 * The app's side of the table viewer. Opening a source at a quote, freshness
 * and regeneration are real: regenerating opens the generate dialog
 * pre-filled from the table's recipe (`TableRegenerateDialogHost`, mounted
 * next to every capability-owned preview). Checking a quote against the
 * current source text is not available yet, so each quote shows as stored.
 */
export const webTableHost: TableHost = {
  interactive: true,
  useTranslate: useTableTranslate,
  openSourceAtEvidence: openGroundedEvidenceSource,
  currentQuoteHash: () =>
    Promise.reject(new Error("Checking a quote against its source is not available yet")),
  getFreshness: (ref) => contentClient.getTableFreshness(ref.workspaceId, ref.artifactId),
  downloadFile: browserDownload,
  onRegenerate: requestTableRegenerate,
};
