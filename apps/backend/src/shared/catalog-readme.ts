/**
 * Which file counts as a catalog entry's README, and how big one may be.
 *
 * Shared by every catalog that shows an author's README next to its own
 * metadata — skills pick it from a stored bundle, MCP servers from GitHub's
 * README API — so both agree on what a README is and when it is too large to
 * be worth showing.
 */

/**
 * A README is shown in a catalog panel, not executed: past this size it is not
 * worth a download, and the panel shows something else instead.
 */
export const MAX_README_BYTES = 512 * 1024;

/**
 * A Markdown README file name, optionally with a language or variant infix
 * (`README.md`, `readme.md`, `README.zh-CN.md`). Matched against a file NAME;
 * callers decide which directory the file has to sit in.
 */
export const README_PATH = /^readme(?:\.[a-z0-9-]+)?\.md$/i;

/**
 * Orders README candidates: the canonical `README.md` first, then any other
 * casing of it, then variants — ties broken by path so the choice is stable
 * whatever order the files were listed in.
 */
export function byReadmePreference(a: { path: string }, b: { path: string }) {
  const rank = (name: string) =>
    name === "README.md" ? 0 : /^readme\.md$/i.test(name) ? 1 : 2;
  return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, "en");
}
