"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  browserDownload,
  type TableHost,
  type TableTranslate,
} from "@sourceweft/builtin-tool-table/ui";
import { openGroundedEvidenceSource } from "./grounded-evidence-source";

const NAMESPACE = "table";

/**
 * Backs the viewer's `table.*` keys with the app's catalog (all three
 * locales). The namespace is passed as a literal so the per-route message
 * subsets (`i18n/client-messages.ts`) can see which routes need it.
 */
function useTableTranslate(): TableTranslate {
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
 * The app's side of the table viewer. Opening a source at a quote is real;
 * checking a quote against the current source text, freshness and regeneration
 * arrive with the generation API, so until then the viewer shows each quote
 * as stored and offers no regenerate control.
 */
export const webTableHost: TableHost = {
  interactive: true,
  useTranslate: useTableTranslate,
  openSourceAtEvidence: openGroundedEvidenceSource,
  currentQuoteHash: () =>
    Promise.reject(new Error("Checking a quote against its source is not available yet")),
  downloadFile: browserDownload,
};
