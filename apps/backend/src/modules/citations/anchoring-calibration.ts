import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@sourceweft/db";
import { assertGitIgnored } from "../../shared/git-ignore";
import { extractCitedClaims } from "./anchoring";
import type { BorderlineCase } from "./anchoring-labels";
import { THRESHOLD_BAND } from "./anchoring-report";
import {
  SEMANTIC_MIN_MARGIN,
  SEMANTIC_MIN_SIMILARITY,
  needsSemanticPass,
} from "./semantic-anchoring";

/**
 * Calibration data for the by-meaning pass (#516). Unlike everything else in
 * this feature, an export holds USER CONTENT (a claim sentence and the cited
 * passage), so it is for the deployment owner to run on their own data and it
 * may only be written to a git-ignored path.
 */

const PASSAGE_MAX_CHARS = 6000;

type Candidate = {
  id: string;
  citationKey: string;
  answer: string;
  passage: string | null;
  similarity: number;
  margin: number | null;
  outcome: string;
  support: string;
  scripts: string;
};

/**
 * The by-meaning decisions closest to a threshold, with the claim sentence
 * and the cited passage recomputed from the stored message and chunk.
 */
export async function findBorderlineCases(input: {
  limit: number;
  days?: number;
  now?: Date;
}) {
  const since = new Date(
    (input.now ?? new Date()).getTime() - (input.days ?? 3650) * 86_400_000,
  );
  const similarity = sql`(c.metadata_json->'anchoring'->'semantic'->>'similarity')::float8`;
  const margin = sql`(c.metadata_json->'anchoring'->'semantic'->>'margin')::float8`;
  const rows = await db.execute<Candidate>(sql`
    select
      c.id as id,
      c.citation_key as "citationKey",
      m.content as answer,
      coalesce(k.content, c.metadata_json->>'content') as passage,
      ${similarity} as similarity,
      ${margin} as margin,
      c.metadata_json->'anchoring'->'semantic'->>'outcome' as outcome,
      coalesce(c.metadata_json->>'support', 'unknown') as support,
      c.metadata_json->'anchoring'->>'scripts' as scripts
    from citations c
    join messages m on m.id = c.message_id
    left join chunks k on k.id = c.chunk_id
    where c.created_at >= ${since}
      and ${similarity} is not null
      and (
        abs(${similarity} - ${SEMANTIC_MIN_SIMILARITY}) <= ${THRESHOLD_BAND}
        or abs(${margin} - ${SEMANTIC_MIN_MARGIN}) <= ${THRESHOLD_BAND}
      )
    order by least(
      abs(${similarity} - ${SEMANTIC_MIN_SIMILARITY}),
      coalesce(abs(${margin} - ${SEMANTIC_MIN_MARGIN}), 1)
    ), c.id
    limit ${input.limit * 3}
  `);

  const cases: BorderlineCase[] = [];
  let skipped = 0;
  for (const row of rows.rows) {
    if (cases.length >= input.limit) break;
    // The sentence that was embedded: the first claim of this citation that
    // differs in script from the passage (the pass tries at most three).
    const claim = (extractCitedClaims(row.answer).get(row.citationKey) ?? [])
      .slice(0, 3)
      .find((text) => row.passage && needsSemanticPass(text, row.passage));
    if (!claim || !row.passage) {
      skipped += 1;
      continue;
    }
    cases.push({
      id: row.id,
      label: null,
      claim,
      passage: row.passage.slice(0, PASSAGE_MAX_CHARS),
      recorded: {
        similarity: row.similarity,
        margin: row.margin,
        outcome: row.outcome,
        support: row.support,
        scripts: row.scripts,
      },
    });
  }
  return { cases, skipped };
}

/** Writes the cases as JSONL to a git-ignored path; refuses any other path. */
export async function writeBorderlineExport(
  path: string,
  cases: readonly BorderlineCase[],
) {
  await assertGitIgnored(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    cases.map((item) => JSON.stringify(item)).join("\n") +
      (cases.length ? "\n" : ""),
  );
}

export const USER_CONTENT_WARNING =
  "WARNING: the export contains USER CONTENT (claim sentences and cited passages from real conversations). " +
  "Run it only on data you own, keep it on this machine, never commit, upload or share it, and delete it when the labelling is done.";
