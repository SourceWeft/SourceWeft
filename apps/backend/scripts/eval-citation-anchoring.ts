/**
 * Measures cross-language citation anchoring (#516) against the real default
 * embedding model: the word matcher alone, then the word matcher plus the
 * by-meaning second pass, per category.
 *
 *   DOTENV_CONFIG_PATH=<env with a synced embedding profile> \
 *     pnpm exec tsx -r dotenv/config scripts/eval-citation-anchoring.ts
 *
 * It calls the embedding provider (a few hundred short texts, well under a
 * cent). Run it when the thresholds or the matcher change and record the
 * result in the change that moved them.
 */
import {
  CROSS_LANGUAGE_CASES,
  SUPPORTED_CATEGORIES,
  UNSUPPORTED_CATEGORIES,
  type CrossLanguageCase,
  type CrossLanguageCategory,
} from "../src/modules/citations/anchoring.cross-language-cases";
import { anchorCitations } from "../src/modules/citations/anchoring";
import { prepareEmbeddingProfile } from "../src/shared/model-gateway/embedding-identity";
import { getRawModelGatewayClient } from "../src/shared/model-gateway/internal/raw";

const prepared = await prepareEmbeddingProfile();
const profile = prepared.profile;
const raw = await getRawModelGatewayClient(
  profile.gatewayConfigId,
  prepared.routedConfig,
);
let embedCalls = 0;
let embedMs = 0;
async function embedTexts(texts: string[]) {
  const started = Date.now();
  const result = await raw.embeddings.embedBatch(
    {
      model: profile.profileAlias,
      profileAlias: profile.profileAlias,
      texts,
      dimensions: profile.requestedDimensions ?? undefined,
      executionMode: "GLOBAL",
    } as never,
    { traceId: "eval-citation-anchoring" } as never,
  );
  embedCalls += 1;
  embedMs += Date.now() - started;
  return result.embeddings as number[][];
}

async function run(testCase: CrossLanguageCase, semantic: boolean) {
  const anchors = await anchorCitations({
    text: `${testCase.claim} [citation:c1].`,
    citations: [
      { citation: "c1", chunkId: "chunk", content: testCase.content },
    ],
    loadChunkContents: async () => new Map(),
    ...(semantic ? { embedTexts } : {}),
  });
  const anchor = anchors.get("c1");
  const strong = anchor?.support === "strong";
  const quote = strong
    ? testCase.content.slice(anchor.startChar!, anchor.endChar!)
    : null;
  return testCase.expect === null
    ? !strong
    : strong && quote !== null && quote.includes(testCase.expect);
}

const tally = new Map<
  CrossLanguageCategory,
  { lexical: number; semantic: number; total: number }
>();
const misses: string[] = [];
for (const testCase of CROSS_LANGUAGE_CASES) {
  const lexical = await run(testCase, false);
  const semantic = await run(testCase, true);
  const entry = tally.get(testCase.category) ?? {
    lexical: 0,
    semantic: 0,
    total: 0,
  };
  entry.total += 1;
  if (lexical) entry.lexical += 1;
  if (semantic) entry.semantic += 1;
  else misses.push(`[${testCase.category}] ${testCase.claim}`);
  tally.set(testCase.category, entry);
}

const pct = (n: number, d: number) => `${n}/${d}`;
console.log("category                 word matcher   + by meaning");
for (const [category, entry] of tally) {
  console.log(
    `${category.padEnd(24)} ${pct(entry.lexical, entry.total).padEnd(14)} ${pct(entry.semantic, entry.total)}`,
  );
}
const sum = (
  categories: readonly CrossLanguageCategory[],
  key: "lexical" | "semantic",
) => {
  let hit = 0,
    total = 0;
  for (const category of categories) {
    const entry = tally.get(category);
    if (entry) {
      hit += entry[key];
      total += entry.total;
    }
  }
  return pct(hit, total);
};
console.log("---");
console.log(
  "supported recall   word matcher",
  sum(SUPPORTED_CATEGORIES, "lexical"),
  "| + by meaning",
  sum(SUPPORTED_CATEGORIES, "semantic"),
);
console.log(
  "unsupported reject word matcher",
  sum(UNSUPPORTED_CATEGORIES, "lexical"),
  "| + by meaning",
  sum(UNSUPPORTED_CATEGORIES, "semantic"),
);
console.log(
  "embedding calls",
  embedCalls,
  "avg ms",
  Math.round(embedMs / Math.max(1, embedCalls)),
);
for (const miss of misses) console.log("  miss", miss);
process.exit(0);
