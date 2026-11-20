"use client";

import { useCallback, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  readOnlyTableHost,
  TableHostProvider,
  type TableHost,
  type TableTranslate,
} from "@sourceweft/builtin-tool-table/ui";

const TABLE_NAMESPACE = "table";

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
 * Hosts the capability viewers need on the public share page. Provided for
 * the subtree rather than configured globally, so the signed-in app's own
 * hosts are never replaced by these narrower ones.
 */
export function ShareCapabilityHosts({ children }: { children?: ReactNode }) {
  return <TableHostProvider host={shareTableHost}>{children}</TableHostProvider>;
}
