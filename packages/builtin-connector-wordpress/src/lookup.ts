import type { WordPressClient } from "./client";
import { WordPressError, type WordPressRestCode } from "./errors";
import type { WpPost, WpTerm } from "./model";

/**
 * Reads shared by the scan and the extract, so both see a single post or page,
 * and name its categories and tags, the same way (equal inputs, equal hash).
 */

/** R8b: a single that answers 401/403 with one of these rights codes has become
 * private or unreadable: it is treated as gone, like a 404. A `LOGIN_REQUIRED`
 * from any other cause means the whole site now needs a login and stays an
 * error. */
const GONE_WHEN_FORBIDDEN: ReadonlySet<WordPressRestCode> = new Set([
  "rest_forbidden",
  "rest_cannot_view",
  "rest_user_cannot_view",
]);

function singleIsGone(error: unknown): boolean {
  return (
    error instanceof WordPressError &&
    error.code === "LOGIN_REQUIRED" &&
    error.restCode !== undefined &&
    GONE_WHEN_FORBIDDEN.has(error.restCode)
  );
}

/**
 * One post or page by id, or `null` when it is gone: a 404, an item that is not
 * published while `includeUnpublished` is false, or a rights refusal (R8b).
 * Every other failure propagates.
 */
export async function fetchSingleItem(
  client: WordPressClient,
  route: "posts" | "pages",
  id: number,
  includeUnpublished: boolean,
): Promise<WpPost | null> {
  try {
    return await client.getItem(route, id, includeUnpublished);
  } catch (error) {
    if (singleIsGone(error)) return null;
    throw error;
  }
}

/** The id to name map of a category or tag list. */
export function nameMap(terms: WpTerm[]): Map<number, string> {
  return new Map<number, string>(terms.map((term) => [term.id, term.name]));
}
