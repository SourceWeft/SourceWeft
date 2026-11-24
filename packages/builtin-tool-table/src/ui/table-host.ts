import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  type GroundedHost,
  type GroundedTranslate,
  type GroundedVersionRef,
} from "@sourceweft/grounded-generation/ui";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import type { TableFreshness } from "@sourceweft/contracts/table";

/**
 * The table viewer's port to the app.
 *
 * Like the study viewers' host, the app injects its facilities once and the
 * package never imports app code: translations, opening a source at a quote,
 * file downloads and regeneration all go through here. A viewer rendered
 * without a configured host gets `readOnlyTableHost`: values and sorting work,
 * nothing opens, downloads or regenerates, and text shows as its key.
 */

export type TableVersionRef = GroundedVersionRef;
export type TableTranslate = GroundedTranslate;

export type TableHost = {
  /** False on public or signed-out surfaces: nothing is opened or regenerated. */
  readonly interactive: boolean;
  /**
   * Translations for the `table.*` keys listed in `TABLE_TRANSLATION_KEYS`. A
   * React hook — only legal from a component's render — so the app can back it
   * with its i18n provider.
   */
  readonly useTranslate: () => TableTranslate;
  /** Opens the source at the quote (the app's source preview). */
  openSourceAtEvidence(
    evidence: GroundedEvidence,
    context: { workspaceId: string; artifactId: string },
  ): void;
  /**
   * `sha256:` digest of the text now at the evidence's range, or null when the
   * chunk no longer exists. Rejecting means "cannot check": the quote is shown
   * without a changed-source note.
   */
  currentQuoteHash(
    evidence: GroundedEvidence,
    context: { workspaceId: string; artifactId: string },
  ): Promise<string | null>;
  /** Whether the table still matches its sources. Absent means not checked. */
  getFreshness?(ref: TableVersionRef): Promise<TableFreshness>;
  downloadFile(fileName: string, mimeType: string, text: string): void;
  /**
   * Present when the app can regenerate (retry a failure, refresh a stale
   * table). A returned promise keeps the button busy until it settles (the
   * app is loading what its dialog needs).
   */
  readonly onRegenerate?: (ref: TableVersionRef) => void | Promise<void>;
};

/**
 * Every translation key the viewer asks the host for, and the column editor
 * asks its `t` for, so an app can check its catalogs cover them.
 * `table.error.code.<code>` is listed once per code.
 */
export const TABLE_TRANSLATION_KEYS = [
  "table.summary",
  "table.source",
  "table.region",
  "table.empty",
  "table.cell.notFound",
  "table.cell.unverified",
  "table.cell.unverifiedHint",
  "table.cell.missing",
  "table.row.failed",
  "table.row.notIndexed",
  "table.row.stale",
  "table.row.sourceDeleted",
  "table.sort.label",
  "table.columns.button",
  "table.columns.label",
  "table.columns.showAll",
  "table.toolbar.regenerate",
  "table.evidence.show",
  "table.evidence.hide",
  "table.evidence.sourceChanged",
  "table.evidence.openSource",
  "table.stale.message",
  "table.stale.sourceDeleted",
  "table.stale.regenerate",
  "table.status.queued",
  "table.status.generating",
  "table.error.generateAgain",
  "table.regenerationFailed.message",
  "table.error.cannotDisplay",
  "table.error.code.INSUFFICIENT_CREDITS",
  "table.error.code.INPUT_TOO_LARGE",
  "table.error.code.NO_INDEXED_SOURCES",
  "table.error.code.MODEL_UNAVAILABLE",
  "table.error.code.GENERATION_QUALITY_TOO_LOW",
  "table.error.code.SOURCE_NOT_READABLE",
  "table.error.code.UNKNOWN",
  // Labels for the CSV and Markdown export (`table.cell.*` serve as the
  // not-mentioned and could-not-be-verified labels there).
  "table.export.menu",
  "table.export.csv",
  "table.export.csvWithEvidence",
  "table.export.markdown",
  "table.export.copied",
  "table.export.source",
  "table.export.evidenceSuffix",
  // The column editor (generate and regenerate dialogs).
  "table.editor.label",
  "table.editor.name",
  "table.editor.namePlaceholder",
  "table.editor.description",
  "table.editor.descriptionPlaceholder",
  "table.editor.type",
  "table.editor.types.text",
  "table.editor.types.number",
  "table.editor.types.date",
  "table.editor.types.boolean",
  "table.editor.add",
  "table.editor.remove",
  "table.editor.max",
] as const;

/** Without translations the key itself is shown. */
const passthroughTranslate: TableTranslate = (key) => key;

export function browserDownload(fileName: string, mimeType: string, text: string) {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const readOnlyTableHost: TableHost = {
  interactive: false,
  useTranslate: () => passthroughTranslate,
  openSourceAtEvidence: () => {},
  currentQuoteHash: () => Promise.reject(new Error("Evidence lookup is not available here")),
  downloadFile: browserDownload,
};

let configuredHost: TableHost | null = null;

/** Installed once by the app shell, before any table viewer renders. */
export function configureTableHost(host: TableHost | null) {
  // The shared evidence popover and stale banner get their host from the
  // viewer (see `groundedHostFor`), so the grounded fallback host, which the
  // study viewers rely on, is left alone.
  configuredHost = host;
}

const TableHostContext = createContext<TableHost | null>(null);

/** Overrides the configured host for a subtree (tests, the share page). */
export function TableHostProvider({
  host,
  children,
}: {
  host: TableHost;
  children?: ReactNode;
}) {
  return createElement(TableHostContext.Provider, { value: host }, children);
}

export function useTableHost(): TableHost {
  return useContext(TableHostContext) ?? configuredHost ?? readOnlyTableHost;
}

/**
 * The shared components ask for `study.evidence.*`, `study.stale.*`,
 * `study.regenerationFailed.*` and `study.error.code.*`; the
 * table shows its own wording under `table.*`, so the app needs one namespace
 * for tables and no dependence on the study catalog.
 */
const GROUNDED_KEY_PREFIXES: readonly (readonly [string, string])[] = [
  ["study.evidence.", "table.evidence."],
  ["study.stale.", "table.stale."],
  ["study.regenerationFailed.", "table.regenerationFailed."],
  ["study.error.code.", "table.error.code."],
];

function tableKeyFor(key: string): string {
  for (const [from, to] of GROUNDED_KEY_PREFIXES) {
    if (key.startsWith(from)) return `${to}${key.slice(from.length)}`;
  }
  return key;
}

/**
 * The slice of the host the shared evidence popover and stale banner use, for
 * one table. `freshness` is what the viewer already knows; `interactive` is
 * the surface's say (the share page is never interactive).
 */
export function groundedHostFor(
  host: TableHost,
  freshness: TableFreshness | undefined,
  interactive: boolean,
): GroundedHost {
  return {
    interactive: host.interactive && interactive,
    useTranslate: () => {
      const translate = host.useTranslate();
      return (key, values) => translate(tableKeyFor(key), values);
    },
    openEvidence: (evidence, context) => host.openSourceAtEvidence(evidence, context),
    currentQuoteHash: (evidence, context) => host.currentQuoteHash(evidence, context),
    getFreshness: async () => ({ status: freshness?.state ?? "unknown" }),
    requestRegenerate: host.onRegenerate,
  };
}

/** `groundedHostFor`, stable across renders while its inputs hold still. */
export function useGroundedHostFor(
  host: TableHost,
  freshness: TableFreshness | undefined,
  interactive: boolean,
): GroundedHost {
  const state = freshness?.state;
  return useMemo(
    () => groundedHostFor(host, freshness, interactive),
    // `freshness` is read only for its state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, state, interactive],
  );
}
