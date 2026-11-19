/**
 * The one place the web knows a connector type by name for selection (R7).
 * Everything a connector needs beyond the generic picker UI — its per-kind
 * icons, the externalId a selected item maps to, and how to count indexed
 * sources inside a selected container — lives in that connector's entry
 * here. A connector type with no entry gets the generic fallback: no icons
 * (the dialog/list fall back to `Folder` / `File` via `selectionIconFor`)
 * and no indexing (a tools-only connector has nothing to count or map).
 */

import {
  Building2,
  File,
  FileText,
  Folder,
  FolderGit2,
  FolderKanban,
  Globe,
  type LucideIcon,
  SquareKanban,
  Users,
} from "lucide-react";
import type {
  ConnectorSelectionDescribeItem,
  ConnectorSelectionItem,
} from "@sourceweft/sdk";

export type SelectionPresenter = {
  kindIcons: Record<string, LucideIcon>;
  /** When true, an entry's `detail` second line is shown only while searching,
   * not while browsing (Dropbox, where the path is redundant inside its own
   * folder). Omitted/false means `detail` shows in both modes, so connectors
   * whose `detail` disambiguates same-named items keep it visible. */
  hideDetailWhileBrowsing?: boolean;
  indexing?: {
    /** externalId of the source a selected item maps to; null for
     * containers (nothing to look up a source by). */
    externalIdFor(item: ConnectorSelectionItem): string | null;
    /** Indexed sources inside a selected container; null when it cannot be
     * counted (for example the container's describe metadata is missing
     * the field this connector counts by). */
    containerIndexedCount(input: {
      item: ConnectorSelectionItem;
      described: ConnectorSelectionDescribeItem | null;
      sources: ReadonlyArray<{
        status: string;
        metadata: Record<string, unknown>;
      }>;
    }): number | null;
  };
};

/** Each selected Dropbox file becomes a source whose externalId is this
 * prefix followed by the Dropbox item id (itself already `id:`-prefixed, so
 * the full externalId looks like `file:id:abc`). Keep in sync with the
 * `file:` prefix in packages/builtin-connector-dropbox/src/adapter.ts. */
const DROPBOX_FILE_EXTERNAL_PREFIX = "file:";

export const selectionPresenters: Record<string, SelectionPresenter> = {
  dropbox: {
    // `FileText` (not the generic `File`) so Dropbox file rows keep the exact
    // glyph they had before the shared picker; the generic fallback in
    // `selectionIconFor` stays `File` for connectors with no icon of their own.
    kindIcons: { folder: Folder, file: FileText },
    // A Dropbox path repeats the folder the user is already looking inside, so
    // it is shown only while searching (unchanged from before the shared picker).
    hideDetailWhileBrowsing: true,
    indexing: {
      externalIdFor(item) {
        if (item.kind !== "file") {
          return null;
        }
        return `${DROPBOX_FILE_EXTERNAL_PREFIX}${item.id}`;
      },
      /**
       * Count indexed sources whose `metadata.pathLower` sits inside the
       * described folder, i.e. starts with `pathLower + "/"`. Used by the
       * settings list to show how many indexed files a selected folder
       * contributed; sources still processing, failed or archived are not
       * counted. Returns null when the folder's describe metadata has no
       * usable `pathLower` (for example it no longer exists).
       */
      containerIndexedCount({ described, sources }) {
        const pathLower = described?.meta.pathLower;
        if (typeof pathLower !== "string") {
          return null;
        }
        const prefix = `${pathLower}/`;
        return sources.filter((source) => {
          if (source.status !== "indexed") {
            return false;
          }
          const sourcePathLower = source.metadata?.pathLower;
          return (
            typeof sourcePathLower === "string" &&
            sourcePathLower.startsWith(prefix)
          );
        }).length;
      },
    },
  },
  // Tools-only connector: nothing is indexed, so there is no `indexing` entry.
  github: {
    kindIcons: { account: Building2, repository: FolderGit2 },
  },
  // Tools-only connector: nothing is indexed, so there is no `indexing`
  // block, only the kind icons for the selection dialog and settings list.
  linear: {
    kindIcons: { team: Users, project: FolderKanban },
  },
  // Jira is tools-only (nothing is indexed): just the per-kind icons for the
  // selection dialog, no `indexing` entry.
  jira: {
    kindIcons: { site: Globe, project: SquareKanban },
  },
};

const FALLBACK_PRESENTER: SelectionPresenter = { kindIcons: {} };

/** The presenter for a connector type, or a generic fallback (R7) when the
 * type has no entry: no icons and no indexing. */
export function selectionPresenterFor(connectorType: string): SelectionPresenter {
  return selectionPresenters[connectorType] ?? FALLBACK_PRESENTER;
}

/** Icon for one entry's kind: the presenter's own icon when it declares
 * one, otherwise a generic `Folder` for an expandable entry or `File` for a
 * non-expandable one (R7). */
export function selectionIconFor(
  presenter: SelectionPresenter,
  kind: string,
  expandable: boolean,
): LucideIcon {
  return presenter.kindIcons[kind] ?? (expandable ? Folder : File);
}
