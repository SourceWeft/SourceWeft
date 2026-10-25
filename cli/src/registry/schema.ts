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
  installRef: z.string().nullable().optional(),
  // The skill's own short name; it becomes the directory name.
  name: z.string(),
  installName: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  verified: z.boolean(),
  // A publisher the platform highlights. Optional: older servers do not send it.
  featured: z.boolean().optional(),
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
      installRef: z.string().nullable().optional(),
      description: z.string(),
      verified: z.boolean(),
      capability: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export type SkillResponse = z.infer<typeof skillResponseSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const referenceResponseSchema = z.object({
  exact: z.boolean(),
  items: z.array(
    z.object({
      slug: z.string(),
      installRef: z.string().nullable(),
      name: z.string(),
      repoUrl: z.string().nullable(),
      repoSubpath: z.string().nullable(),
      description: z.string(),
    }),
  ),
});
export type ReferenceResponse = z.infer<typeof referenceResponseSchema>;

/**
 * What `PUT /v1/market/mcp/:identifier/owner-overrides/tools` answers: the
 * owner's stored overrides with the tool list's standing
 * (`McpOwnerOverrides` in the platform's contracts). Accepted bare or under
 * a `data` envelope, so either shape of the server works.
 */
const mcpOwnerOverrides = z.looseObject({
  identifier: z.string(),
  tools: z
    .looseObject({
      count: z.number().int().nonnegative(),
      submittedAt: z.string(),
    })
    .nullable(),
  updatedAt: z.string().nullable().optional(),
});
export const mcpOwnerOverridesResponseSchema = z.union([
  z
    .looseObject({ data: mcpOwnerOverrides })
    .transform((envelope) => envelope.data),
  mcpOwnerOverrides,
]);
export type McpOwnerOverridesResponse = z.infer<typeof mcpOwnerOverrides>;

/**
 * What `GET /v1/mcp/:identifier/manifest` answers, as `mcp install` and
 * `mcp test` read it: the fields they use, nothing more, and tolerant of
 * values a newer registry may add (a transport or auth type this CLI does not
 * know is reported as unsupported by the command, not as a broken response).
 */
export const mcpManifestResponseSchema = z.looseObject({
  manifest: z.looseObject({
    identifier: z.string(),
    name: z.string(),
    version: z.string().optional(),
    transport: z.string(),
    endpointUrl: z.string().optional(),
    repoUrl: z.string().optional(),
    auth: z
      .looseObject({
        type: z.string().default("none"),
        required: z.boolean().default(false),
        headerName: z.string().optional(),
        allowedHeaderNames: z.array(z.string()).default([]),
      })
      .default({ type: "none", required: false, allowedHeaderNames: [] }),
  }),
});
export type McpManifestResponse = z.infer<typeof mcpManifestResponseSchema>;
export type McpManifestView = McpManifestResponse["manifest"];
