export const UNTRUSTED_LINK_REL = "nofollow ugc noopener noreferrer";

export type UntrustedMarkdownLink =
  | { kind: "external"; href: string; rel: string; target: "_blank" }
  | { kind: "anchor"; href: string }
  | { kind: "text" };

/**
 * What a link inside third-party markdown may point at. Absolute http(s) and
 * mailto links open in a new tab with {@link UNTRUSTED_LINK_REL}; in-page
 * anchors stay in the page. Everything else — relative paths into a repository
 * we do not serve, `javascript:`, `data:` — is not a link here and renders as
 * plain text.
 */
export function untrustedMarkdownLink(
  href: string | null | undefined,
): UntrustedMarkdownLink {
  const value = href?.trim();
  if (!value) return { kind: "text" };
  if (value.startsWith("#")) return { kind: "anchor", href: value };
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return { kind: "text" };
  try {
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
      return { kind: "text" };
    }
    return {
      href: url.toString(),
      kind: "external",
      rel: UNTRUSTED_LINK_REL,
      target: "_blank",
    };
  } catch {
    return { kind: "text" };
  }
}
