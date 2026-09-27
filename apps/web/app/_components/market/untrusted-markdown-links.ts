export const UNTRUSTED_LINK_REL = "nofollow ugc noopener noreferrer";

/**
 * Where a document's relative references lead: its own addresses at a pinned
 * commit, `blob` for the page people read (links) and `raw` for the file itself
 * (images). A reference resolves the way a browser resolves it on that page,
 * so these are the document's URLs, e.g.
 * `https://github.com/o/r/blob/<sha>/servers/x/README.md` and
 * `https://raw.githubusercontent.com/o/r/<sha>/servers/x/README.md`.
 */
export type UntrustedMarkdownBaseUrl = { blob: string; raw: string };

export type UntrustedMarkdownLink =
  | { kind: "external"; href: string; rel: string; target: "_blank" }
  | { kind: "anchor"; href: string }
  | { kind: "text" };

function externalLink(url: URL): UntrustedMarkdownLink {
  return {
    href: url.toString(),
    kind: "external",
    rel: UNTRUSTED_LINK_REL,
    target: "_blank",
  };
}

/**
 * A relative reference (`docs/setup.md`, `./x`, `../x`, `?plain=1`, `#usage`)
 * resolved against the document's own address; null for anything else.
 *
 * Root-relative (`/x`) and protocol-relative (`//host`) references are not
 * resolved: a repository resolves `/x` against its own root, which `base` does
 * not name, and `//host` leaves the repository altogether. They are read as
 * the URL parser reads them — it skips leading control characters and spaces
 * and drops tabs and newlines anywhere — so `\t//host` is caught as well.
 */
function resolveRelativeReference(value: string, base: string) {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) <= 0x20) start += 1;
  const reference = value.slice(start).replace(/[\t\n\r]/g, "");
  if (!reference || /^[/\\]/.test(reference)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return null;
  try {
    const root = new URL(base);
    if (root.protocol !== "https:" && root.protocol !== "http:") return null;
    const url = new URL(reference, root);
    return url.origin === root.origin ? url : null;
  } catch {
    return null;
  }
}

/**
 * What a link inside third-party markdown may point at. Absolute http(s) and
 * mailto links open in a new tab with {@link UNTRUSTED_LINK_REL}. Everything
 * else — `javascript:`, `data:`, root- and protocol-relative paths — is not a
 * link here and renders as plain text.
 *
 * Relative references depend on `base`, the document's own address (see
 * {@link UntrustedMarkdownBaseUrl}). With it they resolve there and open like
 * any external link — `#usage` included, since the document's anchors live on
 * that page. Without it a relative path is text (it points into a repository
 * we do not serve) and an in-page anchor stays in the page.
 */
export function untrustedMarkdownLink(
  href: string | null | undefined,
  base?: string,
): UntrustedMarkdownLink {
  const value = href?.trim();
  if (!value) return { kind: "text" };
  if (value.startsWith("#") && !base) return { kind: "anchor", href: value };
  if (/^(https?:\/\/|mailto:)/i.test(value)) {
    try {
      const url = new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol)
        ? externalLink(url)
        : { kind: "text" };
    } catch {
      return { kind: "text" };
    }
  }
  const resolved = base ? resolveRelativeReference(value, base) : null;
  return resolved ? externalLink(resolved) : { kind: "text" };
}
