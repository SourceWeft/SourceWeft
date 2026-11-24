"use client";

import { useCallback, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  readOnlyStudyHost,
  StudyHostProvider,
  type StudyHost,
  type StudyTranslate,
} from "@sourceweft/builtin-tool-study/ui";
import {
  readOnlyTableHost,
  TableHostProvider,
  type TableHost,
  type TableTranslate,
} from "@sourceweft/builtin-tool-table/ui";

const TABLE_NAMESPACE = "table";
const STUDY_NAMESPACE = "study";

/**
 * The table viewer's `table.*` keys from the app catalog. The namespace is a
 * literal so the per-route message subsets (`i18n/client-messages.ts`) see that
 * the share page needs it.
 */
function useShareTableTranslate(): TableTranslate {
  const t = useTranslations("table");
  return useCallback(
    (key, values) =>
      t(
        (key.startsWith(`${TABLE_NAMESPACE}.`)
          ? key.slice(TABLE_NAMESPACE.length + 1)
          : key) as Parameters<typeof t>[0],
        values,
      ),
    [t],
  );
}

/** The study viewers' `study.*` keys from the app catalog (literal namespace, as above). */
function useShareStudyTranslate(): StudyTranslate {
  const t = useTranslations("study");
  return useCallback(
    (key, values) =>
      t(
        (key.startsWith(`${STUDY_NAMESPACE}.`)
          ? key.slice(STUDY_NAMESPACE.length + 1)
          : key) as Parameters<typeof t>[0],
        values,
      ),
    [t],
  );
}

/**
 * Read-only on purpose: an anonymous viewer opens no source, checks no quote
 * (the public payload has none) and regenerates nothing. Only the wording
 * comes from the app.
 */
const shareTableHost: TableHost = {
  ...readOnlyTableHost,
  useTranslate: useShareTableTranslate,
};

/**
 * Read-only too: cards flip and quizzes are answered in the page, nothing is
 * recorded, no source opens and nothing goes to a chat. Exports still download.
 */
const shareStudyHost: StudyHost = {
  ...readOnlyStudyHost,
  useTranslate: useShareStudyTranslate,
};

/**
 * Hosts the capability viewers need on the public share page. Provided for
 * the subtree rather than configured globally, so the signed-in app's own
 * hosts are never replaced by these narrower ones.
 */
export function ShareCapabilityHosts({ children }: { children?: ReactNode }) {
  return (
    <TableHostProvider host={shareTableHost}>
      <StudyHostProvider host={shareStudyHost}>{children}</StudyHostProvider>
    </TableHostProvider>
  );
}
