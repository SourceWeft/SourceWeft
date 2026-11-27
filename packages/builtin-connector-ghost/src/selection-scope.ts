import { GhostError } from "./errors";

/**
 * Turns a connector's selection (content types, tags and single posts or
 * pages) into the concrete lists a scan must read. An empty selection means all
 * posts and all pages; `type:post` and `type:page` mean the whole type;
 * `tag:<id>` limits both posts and pages to that tag; `post:<id>` and
 * `page:<id>` select single items. A type selected whole makes its narrower
 * selections redundant, so they are dropped. Nothing here issues a request.
 */

export type SelectionItem = { id: string; kind: string };

/** What to read of one route (posts or pages). */
export type RouteScope = {
  /** List every item of the route. */
  all: boolean;
  /** Tag ids to list by, sorted and unique (empty when `all`). */
  tagIds: string[];
  /** Single item ids to list by, sorted and unique (empty when `all`). */
  ids: string[];
};

export type SelectionScope = { posts: RouteScope; pages: RouteScope };

const ID_PATTERN = /^(?:type:(post|page)|(tag|post|page):([0-9a-f]{24}))$/;

type Parsed =
  | { kind: "type"; type: "post" | "page" }
  | { kind: "tag" | "post" | "page"; id: string };

/** Parses one selection id, requiring the declared `kind` to match the prefix
 * (the config schema enforces this; the scan never trusts less). */
function parse(item: SelectionItem): Parsed {
  const match = ID_PATTERN.exec(item.id);
  if (match === null) throw new GhostError("CONFIG_INVALID");
  if (match[1] !== undefined) {
    if (item.kind !== "type") throw new GhostError("CONFIG_INVALID");
    return { kind: "type", type: match[1] as "post" | "page" };
  }
  const prefix = match[2] as "tag" | "post" | "page";
  if (item.kind !== prefix) throw new GhostError("CONFIG_INVALID");
  return { kind: prefix, id: match[3] as string };
}

const sorted = (set: Set<string>): string[] =>
  [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function resolveScope(items: SelectionItem[]): SelectionScope {
  if (items.length === 0) {
    return {
      posts: { all: true, tagIds: [], ids: [] },
      pages: { all: true, tagIds: [], ids: [] },
    };
  }
  let allPosts = false;
  let allPages = false;
  const tagIds = new Set<string>();
  const postIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const item of items) {
    const parsed = parse(item);
    switch (parsed.kind) {
      case "type":
        if (parsed.type === "post") allPosts = true;
        else allPages = true;
        break;
      case "tag":
        tagIds.add(parsed.id);
        break;
      case "post":
        postIds.add(parsed.id);
        break;
      case "page":
        pageIds.add(parsed.id);
        break;
    }
  }
  return {
    posts: {
      all: allPosts,
      tagIds: allPosts ? [] : sorted(tagIds),
      ids: allPosts ? [] : sorted(postIds),
    },
    pages: {
      all: allPages,
      tagIds: allPages ? [] : sorted(tagIds),
      ids: allPages ? [] : sorted(pageIds),
    },
  };
}
