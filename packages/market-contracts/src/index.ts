import { z } from "zod";

export const marketItemKindSchema = z.enum(["skill", "mcp"]);
export const marketItemStatusSchema = z.enum([
  "draft",
  "reviewing",
  "published",
  "unlisted",
  "archived",
]);
export const marketItemVisibilitySchema = z.enum([
  "public",
  "private",
  "internal",
]);

export const mcpTransportSchema = z.enum([
  "streamable_http",
  "http_sse_compat",
  "sse",
  "stdio",
]);

export const mcpAuthTypeSchema = z.enum([
  "none",
  "bearer",
  "api_key_header",
  "custom_headers",
  "oauth",
]);

export const mcpRiskLevelSchema = z.enum([
  "read",
  "write",
  "destructive",
  "unknown",
]);
export const mcpRuntimeSchema = z.enum(["web", "desktop", "hybrid"]);
export const mcpVerificationStatusSchema = z.enum([
  "official",
  "verified",
  "unverified",
]);

export const marketMcpAuthRequirementSchema = z.object({
  type: mcpAuthTypeSchema,
  required: z.boolean().default(false),
  headerName: z.string().optional(),
  displayName: z.string().optional(),
  instructions: z.string().optional(),
  allowedHeaderNames: z.array(z.string()).default([]),
});

export const marketMcpToolManifestSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).default({}),
  risk: mcpRiskLevelSchema.default("unknown"),
});

export const marketMcpManifestSchema = z.object({
  schemaVersion: z.literal(1),
  identifier: z.string(),
  version: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  providerName: z.string().optional(),
  homepageUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  license: z.string().optional(),
  language: z.string().optional(),
  transport: mcpTransportSchema,
  endpointUrl: z.string().url().optional(),
  desktopOnly: z.boolean().default(false),
  webExecutable: z.boolean().default(true),
  official: z.boolean().default(false),
  verified: z.boolean().default(false),
  auth: marketMcpAuthRequirementSchema.default({
    type: "none",
    required: false,
    allowedHeaderNames: [],
  }),
  categories: z.array(z.string()).default([]),
  tools: z.array(marketMcpToolManifestSchema).default([]),
  riskSummary: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  repoUrl: z.string().url().optional(),
  lastIndexedAt: z.string().optional(),
});

export const marketItemSummarySchema = z.object({
  id: z.string(),
  kind: marketItemKindSchema,
  identifier: z.string(),
  name: z.string(),
  summary: z.string(),
  providerName: z.string().nullable().default(null),
  homepageUrl: z.string().url().nullable().default(null),
  iconUrl: z.string().url().nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
  repoUrl: z.string().url().nullable().default(null),
  license: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  status: marketItemStatusSchema,
  visibility: marketItemVisibilitySchema,
  categories: z.array(z.string()).default([]),
  latestVersion: z.string().nullable().default(null),
  transport: mcpTransportSchema.nullable().default(null),
  official: z.boolean().default(false),
  verified: z.boolean().default(false),
  verificationStatus: mcpVerificationStatusSchema.default("unverified"),
  desktopOnly: z.boolean().default(false),
  webExecutable: z.boolean().default(true),
  runtime: mcpRuntimeSchema.default("web"),
  requiresAuth: z.boolean().default(false),
  toolsCount: z.number().int().min(0).default(0),
  lastIndexedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable().default(null),
});

export const marketItemVersionSchema = z.object({
  version: z.string(),
  status: marketItemStatusSchema,
  manifestJson: z.record(z.string(), z.unknown()),
  packageSha256: z.string().nullable().default(null),
  signature: z.string().nullable().default(null),
  signingKeyId: z.string().nullable().default(null),
  provenanceJson: z.record(z.string(), z.unknown()).default({}),
  publishedAt: z.string().nullable().default(null),
});

export const listMarketMcpRequestSchema = z.object({
  query: z.string().optional(),
  /** Comma-separated category slugs, matching any selected category. */
  category: z.string().optional(),
  transport: mcpTransportSchema.optional(),
  official: z.boolean().optional(),
  verified: z.boolean().optional(),
  runtime: mcpRuntimeSchema.optional(),
  includeDesktopOnly: z.boolean().optional(),
  desktopOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const listMarketMcpResponseSchema = z.object({
  items: z.array(marketItemSummarySchema),
  nextCursor: z.string().nullable().default(null),
});

export const getMarketMcpResponseSchema = z.object({
  item: marketItemSummarySchema,
  versions: z.array(marketItemVersionSchema),
});

export const getMarketMcpManifestResponseSchema = z.object({
  item: marketItemSummarySchema,
  version: marketItemVersionSchema,
  manifest: marketMcpManifestSchema,
  signature: z.string().nullable().default(null),
  signingKeyId: z.string().nullable().default(null),
});

export const marketCategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
});

export const listMarketCategoriesResponseSchema = z.object({
  items: z.array(marketCategorySchema),
});

// Per-category item counts for the current query, keyed by category slug, plus
// the distinct total. Computed server-side over the whole catalog so the
// sidebar facet reflects all matching content rather than one loaded page.
export const marketCategoryCountsResponseSchema = z.object({
  counts: z.record(z.string(), z.number().int().min(0)),
  total: z.number().int().min(0),
});

export const marketSigningKeySchema = z.object({
  keyId: z.string(),
  alg: z.literal("ed25519"),
  // Base64 SPKI-encoded Ed25519 public key in `keyId:publicKey` form.
  publicKey: z.string(),
});

export const listMarketKeysResponseSchema = z.object({
  keys: z.array(marketSigningKeySchema),
});

export type MarketItemKind = z.infer<typeof marketItemKindSchema>;
export type MarketItemStatus = z.infer<typeof marketItemStatusSchema>;
export type MarketItemVisibility = z.infer<typeof marketItemVisibilitySchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;
export type McpRiskLevel = z.infer<typeof mcpRiskLevelSchema>;
export type McpRuntime = z.infer<typeof mcpRuntimeSchema>;
export type McpVerificationStatus = z.infer<typeof mcpVerificationStatusSchema>;
export type MarketMcpAuthRequirement = z.infer<
  typeof marketMcpAuthRequirementSchema
>;
export type MarketMcpToolManifest = z.infer<typeof marketMcpToolManifestSchema>;
export type MarketMcpManifest = z.infer<typeof marketMcpManifestSchema>;
export type MarketItemSummary = z.infer<typeof marketItemSummarySchema>;
export type MarketItemVersion = z.infer<typeof marketItemVersionSchema>;
export type ListMarketMcpRequest = z.infer<typeof listMarketMcpRequestSchema>;
export type ListMarketMcpResponse = z.infer<typeof listMarketMcpResponseSchema>;
export type GetMarketMcpResponse = z.infer<typeof getMarketMcpResponseSchema>;
export type GetMarketMcpManifestResponse = z.infer<
  typeof getMarketMcpManifestResponseSchema
>;
export type MarketCategory = z.infer<typeof marketCategorySchema>;
export type ListMarketCategoriesResponse = z.infer<
  typeof listMarketCategoriesResponseSchema
>;
export type MarketCategoryCountsResponse = z.infer<
  typeof marketCategoryCountsResponseSchema
>;
export type MarketSigningKey = z.infer<typeof marketSigningKeySchema>;
export type ListMarketKeysResponse = z.infer<
  typeof listMarketKeysResponseSchema
>;

// ---------------------------------------------------------------------------
// Public skill market — GET /v1/skills*
//
// Everything public and not built in: `visibility = public`, not a builtin,
// active, with a published current version that is not `listing: hidden`. The
// rule is about visibility, never about where a skill came from, so a new kind
// of public skill shows up here without this contract changing.
// ---------------------------------------------------------------------------

// `recommended` = featured publishers first, then verified, then the rank score
// (workspaces that added it and the repository's GitHub stars), then newest. `stars` = GitHub stars of
// the source repository.
export const marketSkillSortSchema = z.enum([
  "recommended",
  "popular",
  "new",
  "name",
  "stars",
]);
export const marketSkillCapabilitySchema = z.enum([
  "prompt-only",
  "executable",
]);

export const marketSkillSummarySchema = z.object({
  slug: z.string(),
  // The author's own short name for the skill (SKILL.md frontmatter `name`).
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  // The skill's own logo (a small PNG thumbnail made at ingest, as a data: URL)
  // or, failing that, its publisher's avatar. Null when neither is known.
  logo: z
    .object({
      url: z.string().max(100_000),
      source: z.enum(["skill", "publisher"]),
    })
    .nullable(),
  // Market category slugs, in taxonomy order.
  categories: z.array(z.string()),
  // A market admin vouched for it. Never self-asserted.
  verified: z.boolean(),
  // From a publisher the platform highlights (a short list of major vendors).
  // About who publishes it, not its content. Defaulted for older servers.
  featured: z.boolean().default(false),
  capability: marketSkillCapabilitySchema.nullable(),
  license: z.string().nullable(),
  // Repository owner, e.g. "anthropics". Null when it cannot be told.
  author: z.string().nullable(),
  repoUrl: z.string().nullable(),
  // Deep link to the skill's directory at the pinned commit.
  sourceUrl: z.string().nullable(),
  // How many SourceWeft workspaces added it. Local installs with the CLI send
  // nothing back, so they are not in this number.
  installCount: z.number().int().nonnegative(),
  listedAt: z.string(),
  version: z.string(),
  // When the current version was published here.
  updatedAt: z.string().nullable(),
  // The name is one `@sourceweft/cli` can install as a directory. The CLI
  // refuses anything else, so no command is offered for it. Always set by the
  // server; optional for answers from before it existed.
  cliInstallable: z.boolean().optional(),
  // GitHub facts about the source repository, refreshed periodically. 0, null
  // and false until the first refresh.
  stars: z.number().int().nonnegative().default(0),
  repoPushedAt: z.string().nullable().default(null),
  repoArchived: z.boolean().default(false),
  // The repository's author claimed it on SourceWeft.
  claimed: z.boolean().default(false),
  // An AI-written one-sentence summary in the requested language (falling
  // back to English), or null when there is none. Model output from
  // third-party content: plain text, render it as untrusted. Optional for
  // answers from before it existed.
  aiSummary: z.string().nullable().optional(),
});

// Languages the market's AI overviews are written in.
export const marketSkillLocaleSchema = z.enum(["en", "zh-CN", "zh-TW"]);

// A skill's AI-written overview, in the requested language or English when
// that one is missing. Plain text, labelled as AI-generated wherever shown.
export const marketSkillAiOverviewSchema = z.object({
  summary: z.string(),
  whatItDoes: z.string(),
  whenToUse: z.string(),
  // Dependencies, scripts, credentials; "" when it needs none.
  requirements: z.string(),
  // The language it is actually in.
  locale: marketSkillLocaleSchema,
  generatedAt: z.string(),
});

export const listMarketSkillsRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  verified: z.boolean().optional(),
  featured: z.boolean().optional(),
  capability: marketSkillCapabilitySchema.optional(),
  sort: marketSkillSortSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  // Only good for the sort that produced it.
  cursor: z.string().min(1).max(1024).optional(),
  // Language of `aiSummary`; English when omitted.
  locale: marketSkillLocaleSchema.optional(),
});

export const listMarketSkillsResponseSchema = z.object({
  items: z.array(marketSkillSummarySchema),
  nextCursor: z.string().nullable(),
  // Every skill matching the query and filters, whatever page this is.
  // Optional for answers from before it existed.
  totalCount: z.number().int().nonnegative().optional(),
});

// Every category, with how many public skills it holds (possibly 0).
export const marketSkillCategorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  count: z.number().int().nonnegative(),
});

export const listMarketSkillCategoriesResponseSchema = z.object({
  items: z.array(marketSkillCategorySchema),
  // Public skills in all; a skill in two categories counts once here.
  total: z.number().int().nonnegative(),
});

// The manifest only — file contents are not served here. It is the COMPLETE
// manifest of the version (scripts and binaries included): a client that
// fetches the pinned commit from GitHub itself checks every file against
// `contentHash` and installs nothing the manifest does not name.
export const marketSkillFileSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  // sha256 of the file's bytes, lowercase hex — the hash recorded at ingest,
  // which is the content the scan verdict is about.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

// What changed from the previous published version: files by path and
// content hash, scripts and scan flags this version adds, and GitHub's own
// comparison of the two commits.
export const marketSkillVersionChangesSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(z.string()),
  newScripts: z.array(z.string()),
  newFlags: z.array(z.string()),
  compareUrl: z.string().nullable(),
});

export const marketSkillVersionSchema = z.object({
  version: z.string(),
  isCurrent: z.boolean(),
  publishedAt: z.string().nullable(),
  commitSha: z.string().nullable(),
  committedAt: z.string().nullable(),
  // Given for the most recent versions only; absent on the oldest one, which
  // has nothing before it.
  changes: marketSkillVersionChangesSchema.optional(),
});

export const getMarketSkillResponseSchema = z.object({
  skill: marketSkillSummarySchema,
  // The current version's SKILL.md, in full. Third-party text: render it as
  // untrusted markdown.
  skillMd: z.string().nullable(),
  files: z.array(marketSkillFileSchema),
  // Published versions, newest first.
  versions: z.array(marketSkillVersionSchema),
  // Attribution for the text above: where it came from, pinned.
  source: z.object({
    repoUrl: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    commitSha: z.string().nullable(),
    committedAt: z.string().nullable(),
    // The skill's directory relative to the repository root; "" for a skill at
    // the root. Given outright so no client has to take `sourceUrl` apart.
    repoSubpath: z.string().nullable(),
  }),
  // Advisory scan flags the current version carries (e.g. `binary:executable`).
  scanFlags: z.array(z.string()),
  // The current version's AI-written overview (`?locale=`, English fallback);
  // null when there is none. Optional for answers from before it existed.
  aiOverview: marketSkillAiOverviewSchema.nullable().optional(),
  // Other public skills from the same repository and in the same category,
  // this one excluded. Optional for answers from before it existed.
  related: z
    .object({
      sameRepository: z.array(marketSkillSummarySchema),
      sameCategory: z.array(marketSkillSummarySchema),
    })
    .optional(),
});

// Editorial collections: a titled, ordered set of public skills.
export const marketSkillCollectionSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  // Public skills in it — the ones its page shows.
  itemCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const listMarketSkillCollectionsResponseSchema = z.object({
  items: z.array(marketSkillCollectionSchema),
});

export const getMarketSkillCollectionResponseSchema = z.object({
  collection: marketSkillCollectionSchema,
  items: z.array(marketSkillSummarySchema),
});

export type MarketSkillSort = z.infer<typeof marketSkillSortSchema>;
export type MarketSkillCapability = z.infer<typeof marketSkillCapabilitySchema>;
export type MarketSkillSummary = z.infer<typeof marketSkillSummarySchema>;
export type MarketSkillLocale = z.infer<typeof marketSkillLocaleSchema>;
export type MarketSkillAiOverview = z.infer<typeof marketSkillAiOverviewSchema>;
export type ListMarketSkillsRequest = z.infer<
  typeof listMarketSkillsRequestSchema
>;
export type ListMarketSkillsResponse = z.infer<
  typeof listMarketSkillsResponseSchema
>;
export type MarketSkillCategory = z.infer<typeof marketSkillCategorySchema>;
export type ListMarketSkillCategoriesResponse = z.infer<
  typeof listMarketSkillCategoriesResponseSchema
>;
export type MarketSkillFile = z.infer<typeof marketSkillFileSchema>;
export type MarketSkillVersion = z.infer<typeof marketSkillVersionSchema>;
export type MarketSkillVersionChanges = z.infer<
  typeof marketSkillVersionChangesSchema
>;
export type MarketSkillCollection = z.infer<typeof marketSkillCollectionSchema>;
export type ListMarketSkillCollectionsResponse = z.infer<
  typeof listMarketSkillCollectionsResponseSchema
>;
export type GetMarketSkillCollectionResponse = z.infer<
  typeof getMarketSkillCollectionResponseSchema
>;
export type GetMarketSkillResponse = z.infer<
  typeof getMarketSkillResponseSchema
>;
