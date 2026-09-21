import { z } from "zod";

/**
 * What the CLI needs from the registry, and nothing more.
 *
 * The full public contract (`@sourceweft/market-contracts`) is written for the
 * website and grows with it: it has since gained a required `logo`, and will
 * gain more. A published CLI validating against all of that would refuse a
 * server that has added — or not yet added — a field the CLI never reads. These
 * schemas hold the fields the CLI relies on and let everything else through
 * untouched (`loose`), so `--json` still prints what the server sent.
 *
 * Tolerance stops at what installing depends on: the commit, the subpath, and
 * every file's path, size and hash are still required and still checked.
 */

const contentHash = z.string().regex(/^[0-9a-f]{64}$/u);

const skillSummary = z.looseObject({
  slug: z.string(),
  // The skill's own short name; it becomes the directory name.
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  verified: z.boolean(),
  // A string rather than an enum: a capability a newer server invents must not
  // make an older CLI refuse the whole response.
  capability: z.string().nullable(),
  license: z.string().nullable(),
  version: z.string(),
});

export const skillResponseSchema = z.looseObject({
  skill: skillSummary,
  files: z.array(
    z.looseObject({
      path: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      contentHash,
    }),
  ),
  source: z.looseObject({
    repoUrl: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    commitSha: z.string().nullable(),
    repoSubpath: z.string().nullable(),
  }),
  scanFlags: z.array(z.string()),
});

export const searchResponseSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      slug: z.string(),
      description: z.string(),
      verified: z.boolean(),
      capability: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export type SkillResponse = z.infer<typeof skillResponseSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
