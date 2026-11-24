import { SITE_NAME } from "../app/seo";

/**
 * Longest `<title>` a detail page should render, counting the root layout's
 * " | SourceWeft" suffix. Search engines flag titles past about 70 characters
 * and cut them in results (Bing Site Scan, #735); 60 leaves margin. CJK names
 * count per character like any other, so the limit is a character count.
 */
export const SEO_TITLE_MAX_LENGTH = 60;

/** The root layout's title template adds this after a page's own title. */
const TITLE_SUFFIX_LENGTH = ` | ${SITE_NAME}`.length;

/**
 * Renders a page title from its message template with the name shortened so
 * the whole `<title>` (template text + name + site suffix) fits
 * {@link SEO_TITLE_MAX_LENGTH}. The name leads: only it is ever cut, at a word
 * boundary where one exists, with "…". Characters are counted by code point,
 * so a surrogate pair is never split. A blank name falls back to `fallback`.
 */
export function fitSeoTitle(
  render: (name: string) => string,
  name: string | null | undefined,
  fallback: string,
): string {
  const clean = (name ?? "").replace(/\s+/g, " ").trim() || fallback;
  const overhead = Array.from(render("")).length + TITLE_SUFFIX_LENGTH;
  const budget = Math.max(SEO_TITLE_MAX_LENGTH - overhead, 8);
  const chars = Array.from(clean);
  if (chars.length <= budget) {
    return render(clean);
  }
  let cut = chars.slice(0, budget - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  // Prefer a word boundary unless it would throw away most of the name.
  if (lastSpace >= budget / 2) {
    cut = cut.slice(0, lastSpace);
  }
  return render(`${cut.replace(/[\s·—–\-_/.,:;]+$/u, "")}…`);
}
