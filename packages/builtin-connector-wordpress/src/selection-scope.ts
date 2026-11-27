import { WordPressError } from "./errors";
import type { WpTerm } from "./model";

/**
 * Turns a connector's selection (content types, categories and single posts or
 * pages) into the concrete set of REST reads a scan must make. The rules follow
 * the design "Selection": an empty selection means all published posts and all
 * pages; `type:post`/`type:page` mean the whole type; `category:<n>` expands to
 * the subtree of `n` and narrows the posts route only; `post:<n>` and `page:<n>`
 * select single items. A type selected whole makes its narrower selections
 * redundant, so they are dropped. Nothing here issues a request; it only
 * resolves ids, so the scan stays the single place that talks to the site.
 */

export type SelectionItem = { id: string; kind: string };

export type PostsScope = {
  /** List every post (no category filter). */
  all: boolean;
  /** Restrict the posts listing to these category ids (already subtree
   * expanded), or `null` to not list posts by category at all. Never empty. */
  categoryIds: number[] | null;
  /** Single posts to fetch by id (empty when `all`, since they are redundant). */
  postIds: number[];
};

export type PagesScope = {
  /** List every page. */
  all: boolean;
  /** Single pages to fetch by id (empty when `all`). */
  pageIds: number[];
};

export type SelectionScope = {
  posts: PostsScope;
  pages: PagesScope;
};

const ID_PATTERN =
  /^(?:type:(post|page)|(category|post|page):([1-9][0-9]{0,9}))$/;

type ParsedSelection =
  | { kind: "type"; type: "post" | "page" }
  | { kind: "category"; id: number }
  | { kind: "post"; id: number }
  | { kind: "page"; id: number };

function invalid(): WordPressError {
  return new WordPressError("CONFIG_INVALID");
}

/** Parses one selection id, requiring the declared `kind` to match the prefix
 * (the config schema already enforces this; the scan must never trust less). */
function parseSelection(item: SelectionItem): ParsedSelection {
  const match = ID_PATTERN.exec(item.id);
  if (match === null) throw invalid();
  if (match[1] !== undefined) {
    if (item.kind !== "type") throw invalid();
    return { kind: "type", type: match[1] as "post" | "page" };
  }
  const prefix = match[2] as "category" | "post" | "page";
  if (item.kind !== prefix) throw invalid();
  return { kind: prefix, id: Number(match[3]) };
}

/**
 * All of `roots` plus every descendant, by the category list's `parent` links.
 * WordPress's `categories` filter does not include children, so the scan sends
 * the whole expanded set. A root that is not in the list expands to just itself
 * (a deleted category then matches no posts). Cycles terminate.
 */
export function expandCategories(
  roots: Iterable<number>,
  categories: WpTerm[],
): number[] {
  const children = new Map<number, number[]>();
  for (const category of categories) {
    const siblings = children.get(category.parent);
    if (siblings) siblings.push(category.id);
    else children.set(category.parent, [category.id]);
  }
  const result = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (result.has(id)) continue;
    result.add(id);
    for (const child of children.get(id) ?? []) {
      if (!result.has(child)) stack.push(child);
    }
  }
  return [...result].sort((a, b) => a - b);
}

export function resolveScope(
  items: SelectionItem[],
  categories: WpTerm[],
): SelectionScope {
  if (items.length === 0) {
    return {
      posts: { all: true, categoryIds: null, postIds: [] },
      pages: { all: true, pageIds: [] },
    };
  }

  let allPosts = false;
  let allPages = false;
  const categoryRoots = new Set<number>();
  const postIds = new Set<number>();
  const pageIds = new Set<number>();

  for (const item of items) {
    const parsed = parseSelection(item);
    switch (parsed.kind) {
      case "type":
        if (parsed.type === "post") allPosts = true;
        else allPages = true;
        break;
      case "category":
        categoryRoots.add(parsed.id);
        break;
      case "post":
        postIds.add(parsed.id);
        break;
      case "page":
        pageIds.add(parsed.id);
        break;
    }
  }

  const categoryIds =
    categoryRoots.size > 0 ? expandCategories(categoryRoots, categories) : null;
  const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);

  return {
    posts: {
      all: allPosts,
      categoryIds: allPosts ? null : categoryIds,
      postIds: allPosts ? [] : sorted(postIds),
    },
    pages: {
      all: allPages,
      pageIds: allPages ? [] : sorted(pageIds),
    },
  };
}
