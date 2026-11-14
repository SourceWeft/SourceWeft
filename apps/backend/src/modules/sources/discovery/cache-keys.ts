import { createHash } from "node:crypto";

/** The same words typed differently are the same topic or query. */
export function normalizeForCache(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Keys carry a hash, never the text: what people search for is not something
 * to leave readable in Redis. The cached values are public web results, so
 * they are shared across users; nothing about the asker is in the key or value.
 */
export function discoveryPlanKey(topic: string) {
  return `discovery:v1:plan:${digest(normalizeForCache(topic))}`;
}

export function discoverySearchKey(query: string, limit: number) {
  return `discovery:v1:search:${limit}:${digest(normalizeForCache(query))}`;
}
