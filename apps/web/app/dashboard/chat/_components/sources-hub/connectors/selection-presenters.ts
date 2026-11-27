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
  FileStack,
  FileText,
  Folder,
  FolderGit2,
  FolderKanban,
  FolderTree,
  Globe,
  LibraryBig,
  type LucideIcon,
  MessageSquare,
  SquareKanban,
  Tag,
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

/**
 * Both WordPress connectors index their posts and pages. A selected post or
 * page is its own source: its externalId is `wordpress:<post|page>:<id>` — the
 * item id is already the kind-qualified `post:<id>` / `page:<id>`, so prefixing
 * `wordpress:` yields the externalId the adapter emits. A content type (`type:
 * post` / `type:page`) and a category (`category:<id>`) are containers: the
 * items inside them are sources of their own, with no per-container count. Keep
 * the `wordpress:` prefix in sync with packages/builtin-connector-wordpress.
 */
const WORDPRESS_PRESENTER: SelectionPresenter = {
  kindIcons: {
    type: FileStack,
    category: FolderTree,
    post: FileText,
    page: File,
  },
  indexing: {
    externalIdFor(item) {
      return item.kind === "post" || item.kind === "page"
        ? `wordpress:${item.id}`
        : null;
    },
    containerIndexedCount() {
      return null;
    },
  },
};

/**
 * Ghost indexes its published posts and pages. A selected post or page is its
 * own source: its externalId is `ghost:<post|page>:<id>` — the item id is
 * already the kind-qualified `post:<id>` / `page:<id>`, so prefixing `ghost:`
 * yields the externalId the adapter emits. A content type (`type:post` /
 * `type:page`) and a tag (`tag:<id>`) are containers: the items inside them are
 * sources of their own, with no per-container count. `ghost.describe` omits an
 * id it does not know (no tombstone), which the shared rows already show as the
 * kind label with "name unavailable". Keep the `ghost:` prefix in sync with
 * packages/builtin-connector-ghost.
 */
const GHOST_PRESENTER: SelectionPresenter = {
  kindIcons: {
    type: FileStack,
    tag: Tag,
    post: FileText,
    page: File,
  },
  indexing: {
    externalIdFor(item) {
      return item.kind === "post" || item.kind === "page"
        ? `ghost:${item.id}`
        : null;
    },
    containerIndexedCount() {
      return null;
    },
  },
};

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
  // Confluence is tools-only too: the kind icons only, no `indexing` entry.
  confluence: {
    kindIcons: { site: Globe, space: LibraryBig, page: FileText },
  },
  // Zotero indexes its items, so a selection syncs after it is saved. A chosen
  // collection is a container: no source is named after it, and the sources
  // inside it carry collection name paths rather than the collection key, so
  // there is no per-collection indexed count. An empty selection indexes the whole library.
  zotero: {
    kindIcons: { collection: FolderTree },
    indexing: {
      externalIdFor() {
        return null;
      },
      containerIndexedCount() {
        return null;
      },
    },
  },
  // Discourse indexes its topics, so a selection syncs after it is saved. Each
  // topic is its own source (`discourse:topic:<id>`, the id being the
  // kind-qualified `topic:<id>`), so a selected topic shows its index state. A
  // category is a container: its topics are sources of their own, with no
  // per-category count. An empty selection indexes nothing.
  discourse: {
    kindIcons: { category: FolderTree, topic: MessageSquare },
    indexing: {
      externalIdFor(item) {
        return item.kind === "topic" ? `discourse:${item.id}` : null;
      },
      containerIndexedCount() {
        return null;
      },
    },
  },
  wordpress: WORDPRESS_PRESENTER,
  // The Application Password connector browses and indexes the same way; both
  // emit `wordpress:<post|page>:<id>` sources, so they share one presenter.
  wordpress_login: WORDPRESS_PRESENTER,
  ghost: GHOST_PRESENTER,
};

const FALLBACK_PRESENTER: SelectionPresenter = { kindIcons: {} };

/** The presenter for a connector type, or a generic fallback (R7) when the
 * type has no entry: no icons and no indexing. */
export function selectionPresenterFor(
  connectorType: string,
): SelectionPresenter {
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
