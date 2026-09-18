export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Blog tags are author-supplied and will become multilingual. A non-Latin tag
 * slugifies to an empty string, which would collide every such tag onto one
 * URL, so those fall back to percent-encoding the original text.
 */
export function toUrlSlug(value: string) {
  return slugify(value) || encodeURIComponent(value.trim());
}
