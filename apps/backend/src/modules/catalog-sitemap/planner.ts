import {
  CATALOG_SITEMAP_TARGET_SIZE,
  SITEMAP_MAX_URLS,
} from "@sourceweft/market-contracts";

export type PrefixCount = { prefix: string; count: number };
/** Prefixes are disjoint and stable across insertions, unlike offset pages. */
export async function planSitemapShards(
  countChildren: (prefix: string) => Promise<PrefixCount[]>,
  target = CATALOG_SITEMAP_TARGET_SIZE,
): Promise<PrefixCount[]> {
  if (!Number.isInteger(target) || target < 1 || target > SITEMAP_MAX_URLS)
    throw new Error("Invalid sitemap target size");
  const pending = [""];
  const shards: PrefixCount[] = [];
  while (pending.length) {
    const parent = pending.pop()!;
    const seen = new Set<string>();
    for (const child of await countChildren(parent)) {
      if (
        !/^[0-9a-f]+$/.test(child.prefix) ||
        child.prefix.length !== parent.length + 1 ||
        !child.prefix.startsWith(parent) ||
        !Number.isSafeInteger(child.count) ||
        child.count < 1 ||
        seen.has(child.prefix)
      )
        throw new Error("Invalid sitemap prefix counts");
      seen.add(child.prefix);
      if (child.count <= target) shards.push(child);
      else {
        if (child.prefix.length >= 32)
          throw new Error("Sitemap hash bucket cannot be split further");
        pending.push(child.prefix);
      }
    }
    if (shards.length + pending.length > SITEMAP_MAX_URLS)
      throw new Error("Sitemap index requires another level");
  }
  return shards.sort((a, b) => a.prefix.localeCompare(b.prefix));
}
