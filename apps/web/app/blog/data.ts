export type BlogVisualKind =
  | "citation-map"
  | "corpus-grid"
  | "team-stream"
  | "eval-board"
  | "ingestion-stack"
  | "memory-index"
  | "private-eval"
  | "agent-trail";

export type BlogAccent = "emerald" | "cyan" | "amber" | "rose" | "violet";

const visualKinds: BlogVisualKind[] = [
  "citation-map",
  "corpus-grid",
  "team-stream",
  "eval-board",
  "ingestion-stack",
  "memory-index",
  "private-eval",
  "agent-trail",
];

const accents: BlogAccent[] = ["emerald", "cyan", "amber", "rose", "violet"];

export function resolveBlogVisual(seed: string) {
  return visualKinds[hashSeed(seed) % visualKinds.length] ?? "citation-map";
}

export function resolveBlogAccent(seed: string) {
  return accents[hashSeed(seed) % accents.length] ?? "emerald";
}

function hashSeed(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash;
}

