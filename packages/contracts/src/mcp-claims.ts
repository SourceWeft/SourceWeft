import { z } from "zod";

/**
 * A publisher claiming a catalog MCP server (Issue #367, W7) and correcting
 * what the page shows about it.
 *
 * Who may claim: whoever controls the identity the entry is published under.
 * An `io.github.<owner>/*` entry, or one whose declared repository is on
 * github.com, is claimed by proving control of that GitHub account or
 * organization through the signed-in member's own GitHub link (an
 * organization needs the admin/owner role, read with the member's own OAuth
 * token). A domain-namespace entry (`com.notion/*` → `notion.com`) is claimed
 * by publishing a token the platform issues: in a DNS TXT record at
 * `_sourceweft-claim.<domain>`, or at
 * `https://<domain>/.well-known/sourceweft-claim`. The token is bound to the
 * member and the entry and expires after seven days; verification reads
 * exactly that record or that path and nothing else on the publisher's site.
 */

export const mcpClaimMethodSchema = z.enum(["github", "dns_txt", "well_known"]);
export type McpClaimMethod = z.infer<typeof mcpClaimMethodSchema>;

export const mcpClaimStatusSchema = z.enum(["pending", "verified", "revoked"]);
export type McpClaimStatus = z.infer<typeof mcpClaimStatusSchema>;

/** The DNS record name and well-known path a domain claim uses. */
export const MCP_CLAIM_DNS_LABEL = "_sourceweft-claim";
export const MCP_CLAIM_WELL_KNOWN_PATH = "/.well-known/sourceweft-claim";
/** How long a pending domain claim's token stays valid. */
export const MCP_CLAIM_TOKEN_TTL_DAYS = 7;

export const mcpClaimSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  method: mcpClaimMethodSchema,
  status: mcpClaimStatusSchema,
  // What was (or is to be) proven: a GitHub login, or a domain.
  target: z.string(),
  createdAt: z.string(),
  // When a pending token stops working; null for a GitHub claim.
  expiresAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  // Why the last verification attempt did not succeed, when it did not.
  lastError: z.string().nullable(),
});
export type McpClaim = z.infer<typeof mcpClaimSchema>;

/** What a pending domain claim's owner has to publish, shown once at start. */
export const mcpClaimInstructionsSchema = z.object({
  token: z.string(),
  domain: z.string(),
  dnsRecordName: z.string(),
  dnsRecordValue: z.string(),
  wellKnownUrl: z.string().url(),
  wellKnownBody: z.string(),
  expiresAt: z.string(),
});
export type McpClaimInstructions = z.infer<typeof mcpClaimInstructionsSchema>;

/** Whether the GitHub method applies to an entry, and to this viewer. */
export const mcpClaimGithubMethodSchema = z.object({
  available: z.boolean(),
  // The GitHub account or organization the entry is published under.
  owner: z.string().nullable(),
  reason: z
    .enum(["not_github_entry", "not_linked"])
    .nullable(),
});

/** Whether the domain methods apply: the entry's namespace domain, if any. */
export const mcpClaimDomainMethodSchema = z.object({
  available: z.boolean(),
  domain: z.string().nullable(),
});

/**
 * A link a verified owner may set: https only, no credentials. Checked here,
 * on the server, whatever a client sent — the values end up as `href`s and
 * `src`s on the public page.
 */
export const mcpOwnerUrlSchema = z
  .url({ protocol: /^https$/, hostname: /^[^\s]+$/ })
  .max(2_048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password;
      } catch {
        return false;
      }
    },
    { message: "URL must not carry credentials" },
  );

/** What a verified owner may set; every field optional, null clears it. */
export const mcpOwnerOverridesInputSchema = z
  .object({
    iconUrl: mcpOwnerUrlSchema.nullable().optional(),
    summary: z.string().trim().max(300).nullable().optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    documentationUrl: mcpOwnerUrlSchema.nullable().optional(),
    homepageUrl: mcpOwnerUrlSchema.nullable().optional(),
    repoUrl: mcpOwnerUrlSchema.nullable().optional(),
    // The SPDX id or name of the license the code is released under, and its
    // main programming language. Short labels, never HTML.
    license: z.string().trim().max(120).nullable().optional(),
    language: z.string().trim().max(64).nullable().optional(),
    deprecated: z.boolean().optional(),
  })
  .strict();
export type McpOwnerOverridesInput = z.infer<typeof mcpOwnerOverridesInputSchema>;

/** The owner's stored corrections, with the tool list's standing. */
export const mcpOwnerOverridesSchema = z.object({
  identifier: z.string(),
  values: mcpOwnerOverridesInputSchema,
  tools: z
    .object({ count: z.number().int().nonnegative(), submittedAt: z.string() })
    .nullable(),
  updatedAt: z.string().nullable(),
});
export type McpOwnerOverrides = z.infer<typeof mcpOwnerOverridesSchema>;

// GET /v1/market/mcp/:identifier/claim — where this entry stands for the
// signed-in viewer.
export const mcpClaimOverviewSchema = z.object({
  identifier: z.string(),
  name: z.string(),
  // Someone holds a verified claim on it.
  claimed: z.boolean(),
  // The viewer is one of its verified owners.
  claimedByYou: z.boolean(),
  // A market admin blocked the viewer from claiming this server (the block
  // outlives any claim row): no method is offered.
  blocked: z.boolean(),
  // The viewer's own claims on it, pending and verified, newest first.
  viewerClaims: z.array(mcpClaimSchema),
  methods: z.object({
    github: mcpClaimGithubMethodSchema,
    domain: mcpClaimDomainMethodSchema,
  }),
  // Only for a verified owner; null otherwise.
  overrides: mcpOwnerOverridesSchema.nullable(),
});
export type McpClaimOverview = z.infer<typeof mcpClaimOverviewSchema>;

// POST /v1/market/mcp/:identifier/claims
export const startMcpClaimRequestSchema = z
  .object({ method: mcpClaimMethodSchema })
  .strict();
export type StartMcpClaimRequest = z.infer<typeof startMcpClaimRequestSchema>;

// A GitHub claim is decided on the spot (verified, or refused with an error);
// a domain claim comes back pending with what to publish.
export const startMcpClaimResponseSchema = z.object({
  claim: mcpClaimSchema,
  instructions: mcpClaimInstructionsSchema.nullable(),
});
export type StartMcpClaimResponse = z.infer<typeof startMcpClaimResponseSchema>;

// POST /v1/market/mcp-claims/:claimId/verify — looks the token up now.
export const verifyMcpClaimResponseSchema = z.object({
  claim: mcpClaimSchema,
});
export type VerifyMcpClaimResponse = z.infer<typeof verifyMcpClaimResponseSchema>;

// POST /v1/market/mcp-claims/:claimId/revoke (the owner's own). An admin's
// POST /v1/market/admin/mcp/claims/:claimId/revoke also blocks the member on
// that server (see the block routes below).
export const revokeMcpClaimResponseSchema = z.object({
  claim: mcpClaimSchema,
});
export type RevokeMcpClaimResponse = z.infer<typeof revokeMcpClaimResponseSchema>;

// PUT /v1/market/mcp/:identifier/owner-overrides
export const setMcpOwnerOverridesRequestSchema = mcpOwnerOverridesInputSchema;

/** A claim as the market admin lists it. */
export const mcpClaimAdminRowSchema = mcpClaimSchema.extend({
  userId: z.string(),
  revokedBy: z.string().nullable(),
});
export type McpClaimAdminRow = z.infer<typeof mcpClaimAdminRowSchema>;

// GET /v1/market/admin/mcp/claims[?identifier=]
export const listMcpClaimsAdminResponseSchema = z.object({
  items: z.array(mcpClaimAdminRowSchema),
});
export type ListMcpClaimsAdminResponse = z.infer<
  typeof listMcpClaimsAdminResponseSchema
>;

/**
 * A market admin's block of one member on one server. It does not depend on
 * any claim row: a member who gave their claim up first is blocked all the
 * same. While it stands the member cannot start or verify a claim there, and
 * what they wrote on the listing is gone.
 */
export const mcpClaimBlockSchema = z.object({
  identifier: z.string(),
  userId: z.string(),
  blockedBy: z.string(),
  createdAt: z.string(),
});
export type McpClaimBlock = z.infer<typeof mcpClaimBlockSchema>;

// POST /v1/market/admin/mcp/blocks and POST .../blocks/unblock
export const mcpClaimBlockRequestSchema = z
  .object({
    identifier: z.string().trim().min(1).max(512),
    userId: z.string().trim().min(1).max(256),
  })
  .strict();
export type McpClaimBlockRequest = z.infer<typeof mcpClaimBlockRequestSchema>;

export const blockMcpMemberResponseSchema = z.object({
  block: mcpClaimBlockSchema,
});
export type BlockMcpMemberResponse = z.infer<typeof blockMcpMemberResponseSchema>;

export const unblockMcpMemberResponseSchema = z.object({
  // False when the member was not blocked.
  unblocked: z.boolean(),
});
export type UnblockMcpMemberResponse = z.infer<
  typeof unblockMcpMemberResponseSchema
>;

// GET /v1/market/admin/mcp/blocks[?identifier=]
export const listMcpClaimBlocksResponseSchema = z.object({
  items: z.array(mcpClaimBlockSchema),
});
export type ListMcpClaimBlocksResponse = z.infer<
  typeof listMcpClaimBlocksResponseSchema
>;

/** Every error code the claim routes answer with, for the web's messages. */
export const MCP_CLAIM_ERROR_CODES = [
  "MCP_CLAIM_ENTRY_NOT_FOUND",
  "MCP_CLAIM_METHOD_UNAVAILABLE",
  "MCP_CLAIM_GITHUB_NOT_LINKED",
  "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH",
  "MCP_CLAIM_GITHUB_ORG_ROLE",
  "MCP_CLAIM_GITHUB_ORG_SCOPE",
  "MCP_CLAIM_GITHUB_UNAVAILABLE",
  "MCP_CLAIM_NOT_FOUND",
  "MCP_CLAIM_NOT_PENDING",
  "MCP_CLAIM_EXPIRED",
  "MCP_CLAIM_TOKEN_NOT_FOUND",
  "MCP_CLAIM_LOOKUP_FAILED",
  "MCP_CLAIM_REQUIRED",
  "MCP_CLAIM_BLOCKED",
  // Too many claim or verify attempts; try again later.
  "MCP_CLAIM_RATE_LIMITED",
] as const;
export type McpClaimErrorCode = (typeof MCP_CLAIM_ERROR_CODES)[number];
