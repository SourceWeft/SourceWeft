import { z } from "zod";

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

/**
 * Whether a server needs a credential at all: `none` serves anonymous calls,
 * `optional` serves them but accepts a credential (more quota, more tools),
 * `required` refuses them. The names follow the MCP remote-auth proposal
 * (SEP-2742, now ext-server-card #13) so a standard declaration maps 1:1.
 */
export const mcpAuthPostureSchema = z.enum(["none", "optional", "required"]);

/**
 * One way to authenticate to a server. A server can accept several (OAuth or
 * an API key); a member connects with one of them. A header method names the
 * header the server reads; `scheme: "bearer"` means its value is sent as
 * `Bearer <secret>`. `description` is the publisher's own hint (the registry
 * header description), shown next to the field.
 */
export const marketMcpAuthMethodSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("oauth") }),
  z.object({
    type: z.literal("header"),
    name: z.string(),
    scheme: z.enum(["bearer"]).optional(),
    description: z.string().optional(),
  }),
]);

export const marketMcpAuthRequirementSchema = z.object({
  type: mcpAuthTypeSchema,
  required: z.boolean().default(false),
  headerName: z.string().optional(),
  displayName: z.string().optional(),
  instructions: z.string().optional(),
  allowedHeaderNames: z.array(z.string()).default([]),
  // Absent on manifests written before they existed; `type`/`required` stay
  // the install-time auth type and remain authoritative for runtime.
  posture: mcpAuthPostureSchema.optional(),
  methods: z.array(marketMcpAuthMethodSchema).optional(),
});


// ---------------------------------------------------------------------------
// Owner layer (Issue #367, W7). A verified claimant's corrections are kept
// apart from the federated data and applied on read as the top layer of the
// public item and manifest. Every field it set is named in `fields`, so a
// reader can tell the publisher's own word from the registry's.
// ---------------------------------------------------------------------------

export const marketMcpOwnerFieldSchema = z.enum([
  "iconUrl",
  "summary",
  "description",
  "documentationUrl",
  "homepageUrl",
  "repoUrl",
  "deprecated",
  "tools",
]);

export const marketMcpOwnerLayerSchema = z.object({
  source: z.literal("owner"),
  fields: z.array(marketMcpOwnerFieldSchema).default([]),
  // The publisher's documentation, as they declared it. A link, never read.
  documentationUrl: z.string().url().nullable().default(null),
  // The publisher says this server is no longer maintained.
  deprecated: z.boolean().default(false),
  // When the owner last submitted a tool list (`sourceweft mcp inspect`).
  toolsSubmittedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});

// Where a manifest tool came from. Absent on tools the registry, a remote
// probe or the sandbox listed; `owner-submitted` tools were listed by the
// server's owner with their own credentials and are shown but never trusted
// for unattended execution (their risk is always `unknown`).
export const MARKET_MCP_TOOL_SOURCE_OWNER_SUBMITTED = "owner-submitted";
// Tools read by SourceWeft itself with a reference account, and tools observed
// through members' own connections (Issue #367). Both are shown, neither is
// trusted for unattended execution (risk `unknown`).
export const MARKET_MCP_TOOL_SOURCE_PLATFORM_INDEXED = "platform-indexed";
export const MARKET_MCP_TOOL_SOURCE_MEMBER_OBSERVED = "member-observed";

// The approved reference profile a platform snapshot was read with. Describes
// the kind of account, never which account. Free text written by an admin: it
// is stored with the snapshot and never part of a public answer.
export const marketMcpReferenceProfileSchema = z
  .object({
    tier: z.string().trim().min(1).max(64),
    role: z.string().trim().min(1).max(64),
    scopes: z.array(z.string().trim().min(1).max(128)).max(32),
    // The day the profile was approved or last reviewed, `YYYY-MM-DD`.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type MarketMcpReferenceProfile = z.infer<
  typeof marketMcpReferenceProfileSchema
>;

// Where the tool list on a page came from when it is not the owner's, and
// whether it is still about the server at the listing's current address.
export const marketMcpToolsReferenceSchema = z.object({
  source: z.enum([
    MARKET_MCP_TOOL_SOURCE_PLATFORM_INDEXED,
    MARKET_MCP_TOOL_SOURCE_MEMBER_OBSERVED,
  ]),
  // When the list was read (a member observation: the day only).
  observedAt: z.string(),
  // The listing's endpoint changed since the list was read.
  stale: z.boolean(),
});
export type MarketMcpToolsReference = z.infer<
  typeof marketMcpToolsReferenceSchema
>;

/**
 * Where an MCP server's logo came from, first hit of the chain: the registry's
 * own `icons`, the server's `initialize` answer (`serverInfo.icons`), the
 * GitHub avatar of the namespace owner or the declared repository's owner, the
 * GitHub MCP Registry's owner avatar, the namespace domain's favicon fetched
 * at sync and served from our own storage, or none (a monogram placeholder).
 */
export const marketMcpIconSourceSchema = z.enum([
  "registry",
  "server-info",
  "github-avatar",
  "github-registry",
  "favicon",
  "placeholder",
  // A verified owner set the logo (Issue #367, W7); applied on read.
  "owner",
]);

export const marketMcpToolManifestSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).default({}),
  risk: mcpRiskLevelSchema.default("unknown"),
  source: z.string().optional(),
});

/**
 * Who publishes a server, derived from its registry namespace. The official
 * registry verifies DNS or HTTP ownership of a reverse-DNS namespace
 * (`com.notion` → notion.com) before accepting a publish, so the domain is a
 * trustworthy identity; `io.github.*` namespaces are GitHub accounts and have
 * no publisher. `endpointMatch` is true when the server's remote endpoint is
 * on that domain or a subdomain of it (mcp.notion.com under notion.com): the
 * publisher also runs the server.
 */
export const marketMcpPublisherSchema = z.object({
  domain: z.string(),
  source: z.literal("registry-namespace"),
  endpointMatch: z.boolean(),
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
  // Absent on manifests written before the icon chain existed.
  iconSource: marketMcpIconSourceSchema.optional(),
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
  // The publisher's documentation (set by a verified owner); a link only.
  documentationUrl: z.string().url().optional(),
  // Present when a verified owner's corrections were applied over the
  // federated data (Issue #367, W7).
  owner: marketMcpOwnerLayerSchema.optional(),
  // Present when the tools came from a platform snapshot or members'
  // observation instead of the registry, a probe or the owner (Issue #367).
  toolsReference: marketMcpToolsReferenceSchema.optional(),
  // Absent on manifests written before it existed and on servers without a
  // domain publisher.
  publisher: marketMcpPublisherSchema.optional(),
});

// ---------------------------------------------------------------------------
// What a remote MCP server said about itself (Issue #367, W1). Kept in the
// version's provenance, never in the manifest; `tools/list` goes to
// `manifest.tools`. Third-party text: render it as untrusted.
// ---------------------------------------------------------------------------

// An icon the server offers in its `serverInfo`: the MCP `Icon` shape, `src`
// an https URL.
export const marketMcpServerIconSchema = z.object({
  src: z.string().url(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
});

export const marketMcpServerInfoSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  websiteUrl: z.string().url().optional(),
  icons: z.array(marketMcpServerIconSchema).optional(),
});

// `source` says who asked: "remote-probe" is federation's unauthenticated
// `initialize` of the remote endpoint; a sandboxed stdio start writes its own.
export const marketMcpSelfDescriptionSchema = z.object({
  source: z.string(),
  recordedAt: z.string(),
  serverInfo: marketMcpServerInfoSchema.optional(),
  instructions: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

// The human fields of the RFC 9728 protected-resource metadata an endpoint
// answering 401 points at. `resourceDocumentation` is shown as a link and
// never fetched.
export const marketMcpAuthMetadataSchema = z.object({
  resourceName: z.string().optional(),
  resourceDocumentation: z.string().url().optional(),
});

export type MarketMcpServerIcon = z.infer<typeof marketMcpServerIconSchema>;
export type MarketMcpServerInfo = z.infer<typeof marketMcpServerInfoSchema>;
export type MarketMcpSelfDescription = z.infer<
  typeof marketMcpSelfDescriptionSchema
>;
export type MarketMcpAuthMetadata = z.infer<typeof marketMcpAuthMetadataSchema>;

// Languages MCP servers' AI overviews are written in.
export const marketMcpLocaleSchema = z.enum(["en", "zh-CN", "zh-TW"]);

// An MCP server's AI-written overview, in the requested language or English
// when that one is missing. Model output from third-party content: plain
// text, labelled as AI-generated wherever shown, rendered as untrusted text.
export const marketMcpAiOverviewSchema = z.object({
  summary: z.string(),
  whatItDoes: z.string(),
  whenToUse: z.string(),
  // Runtime, accounts and credentials it needs; "" when it needs none.
  requirements: z.string(),
  // Credentials, payments, keys, write or destructive actions to know about
  // before installing; null when there are none.
  cautions: z.string().nullable(),
  // The language it is actually in.
  locale: marketMcpLocaleSchema,
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Sandboxed stdio package validation (Issue #367, W1b). A version that lists
// `packages[]` is started once in the sandbox runtime with placeholder
// credentials and asked for its tools. A success writes `selfDescription`
// (`source: "stdio-sandbox"`) and `validatedAt` to the version's provenance
// and the tools to its manifest; a failure writes `validation` below and
// leaves the tools alone.
// ---------------------------------------------------------------------------

// Why the package could not be validated: it did not install, did not start,
// started but did not speak MCP, took too long, or is of a kind the sandbox
// cannot run (a container image, say).
export const mcpStdioValidationReasonSchema = z.enum([
  "install",
  "start",
  "protocol",
  "timeout",
  "unsupported-package",
]);

export const marketMcpValidationSchema = z.object({
  // `unsupported` is reserved for `unsupported-package`.
  status: z.enum(["failed", "unsupported"]),
  reason: mcpStdioValidationReasonSchema,
  at: z.string(),
  // A bounded excerpt of what the sandbox saw (an install error, an exit
  // code); third-party text, rendered as untrusted.
  detail: z.string().optional(),
});

// What a card says instead of "0 tools": the latest version's failed
// validation, when it has one and no tools.
export const marketMcpToolsValidationSchema = marketMcpValidationSchema.pick({
  status: true,
  reason: true,
  at: true,
});

export const marketItemSummarySchema = z.object({
  id: z.string(),
  identifier: z.string(),
  name: z.string(),
  summary: z.string(),
  providerName: z.string().nullable().default(null),
  homepageUrl: z.string().url().nullable().default(null),
  iconUrl: z.string().url().nullable().default(null),
  // Where `iconUrl` came from; `placeholder` when it is null. Optional for
  // answers from before it existed.
  iconSource: marketMcpIconSourceSchema.optional(),
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
  // The AI overview's one-sentence summary in the requested language (falling
  // back to English), or null when there is none. Model output from
  // third-party content: plain text, render it as untrusted. Optional for
  // answers from before it existed.
  aiSummary: z.string().nullable().optional(),
  // Languages the latest version has a visible AI overview in, without
  // fallback. Optional for answers from before it existed.
  overviewLocales: z.array(marketMcpLocaleSchema).optional(),
  // The latest version's domain publisher; null when it has none. Optional
  // for answers from before it existed.
  publisher: marketMcpPublisherSchema.nullable().optional(),
  // The latest version's failed stdio validation while it has no tools (see
  // `marketMcpValidationSchema`); null when it has tools or was never tried.
  // Optional for answers from before it existed.
  toolsValidation: marketMcpToolsValidationSchema.nullable().optional(),
  // A verified owner claimed this server (Issue #367, W7). Optional for
  // answers from before it existed.
  claimed: z.boolean().optional(),
  // The owner marked it deprecated.
  deprecated: z.boolean().optional(),
  // The owner's corrections applied over the federated data; null when none.
  owner: marketMcpOwnerLayerSchema.nullable().optional(),
});

export const marketItemVersionSchema = z.object({
  version: z.string(),
  status: marketItemStatusSchema,
  manifestJson: z.record(z.string(), z.unknown()),
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
  // Language of `aiSummary`; English when omitted.
  locale: marketMcpLocaleSchema.optional(),
});

export const listMarketMcpResponseSchema = z.object({
  items: z.array(marketItemSummarySchema),
  nextCursor: z.string().nullable().default(null),
});

// Where an MCP server's README stands. `pending` until it is first read;
// `not_found` when the repository has none to show (no README, or one that is
// not Markdown); `unsupported_host` when the repository is not on GitHub.
export const mcpReadmeStatusSchema = z.enum([
  "pending",
  "ok",
  "not_found",
  "too_large",
  "unsupported_host",
  "error",
]);

// The README file on GitHub. `blobUrl` and `rawUrl` are the file's OWN
// addresses at `ref` (not its directory's), so a relative link in the README
// resolves against them the way a browser resolves it on that page. `ref` is
// the commit the README was read at; null when none was pinned (a README too
// large to store), in which case the URLs name the default branch (`HEAD`).
export const marketMcpReadmeSourceSchema = z.object({
  repoUrl: z.string().url(),
  ref: z.string().nullable(),
  // Repository-relative, e.g. `README.md` or `mcp/README.md`.
  path: z.string(),
  blobUrl: z.string().url(),
  rawUrl: z.string().url(),
});

// The latest version's README. `markdown` is present only when `status` is
// `ok`; it is the author's text, so render it as untrusted markdown. `source`
// is null when no README file is known.
export const marketMcpReadmeSchema = z.object({
  status: mcpReadmeStatusSchema,
  markdown: z.string().optional(),
  source: marketMcpReadmeSourceSchema.nullable(),
});

/**
 * A catalog server seen as a member of a product group (Issue #367, W8): the
 * listing fields a card needs, plus whether this member's publisher runs its
 * endpoint (the product's own server).
 */
export const marketMcpProductGroupMemberSchema = marketItemSummarySchema.extend(
  {
    publisherMatch: z.boolean(),
  },
);

/**
 * The servers that integrate one product, anchored by the product's own
 * server: the one whose publisher domain (`domain`) also runs its endpoint.
 * `brand` is the domain's registrable label as it appears in slugs (`notion`
 * for notion.com). `members` holds every member in display order — the
 * official server first, then the catalog's browse order — including the
 * server the detail was read for.
 */
export const marketMcpProductGroupSchema = z.object({
  domain: z.string(),
  brand: z.string(),
  officialIdentifier: z.string(),
  members: z.array(marketMcpProductGroupMemberSchema),
});

// ---------------------------------------------------------------------------
// Quality scorecard (Issue #367, W6). A deterministic reading of how complete
// a catalog entry is, computed from the stored manifest, provenance and
// README state on every detail read: no model, no stored column. Modelled on
// LobeHub's public score (weighted items, required items, A/B/F) with the
// required items conditional on the kind of entry: a remote endpoint must be
// reachable and declare its auth, tools are required only where the server
// can be listed without a credential, a description is always required.
// ---------------------------------------------------------------------------

export const marketMcpScoreItemKeySchema = z.enum([
  "reachable",
  "authDeclared",
  "hasTools",
  "hasDescription",
  "hasLogo",
  "hasDocs",
  "hasLicense",
]);

// F when a required item is not met, else by the share of the total weight
// that is met: A from 80 %, B from 60 %, F below.
export const marketMcpScoreGradeSchema = z.enum(["A", "B", "F"]);

export const marketMcpScoreItemSchema = z.object({
  key: marketMcpScoreItemKeySchema,
  weight: z.number().int().min(0),
  // False when the item does not apply to this entry (a hosted-only service
  // has no license to declare): it is then neither met nor required and its
  // weight is left out of the percentage. Absent means true, for answers from
  // before it existed.
  applicable: z.boolean().default(true),
  // Required for THIS entry: a remote's reachability, say, but not a stdio
  // package's.
  required: z.boolean(),
  met: z.boolean(),
});

export const marketMcpScoreSchema = z.object({
  grade: marketMcpScoreGradeSchema,
  // Met weight as a share of the weight that applies, 0–100, whole number.
  percentage: z.number().int().min(0).max(100),
  // Every item, in the definition's order, whether met or not.
  items: z.array(marketMcpScoreItemSchema),
});

// ---------------------------------------------------------------------------
// Tool revisions (Issue #367). A listing's tool list has a history per source:
// a new revision whenever the canonicalised list differs from that source's
// previous one. The number is the history of THIS listing, not the server's
// own version. No member or team identifier is ever part of it.
// ---------------------------------------------------------------------------

export const marketMcpToolRevisionSourceSchema = z.enum([
  "owner",
  "platform-indexed",
  "member-observed",
]);
export type MarketMcpToolRevisionSource = z.infer<
  typeof marketMcpToolRevisionSourceSchema
>;

export const MARKET_MCP_TOOL_REVISIONS_MAX_LIMIT = 50;
export const MARKET_MCP_TOOL_REVISIONS_DEFAULT_LIMIT = 20;

export const marketMcpToolFieldSchema = z.enum([
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
]);

// On the detail answer: the current revision of the source whose tools the
// page shows. Null when that list has no revision history.
export const marketMcpToolsRevisionSchema = z.object({
  source: marketMcpToolRevisionSourceSchema,
  revision: z.number().int().min(1),
  observedAt: z.string(),
  lastConfirmedAt: z.string(),
});

export const marketMcpToolRevisionSchema = z.object({
  source: marketMcpToolRevisionSourceSchema,
  revision: z.number().int().min(1),
  // The newest revision of its source, and not a withdrawal.
  current: z.boolean(),
  // The source took its list back; not the same as a valid empty list.
  withdrawn: z.boolean(),
  toolsCount: z.number().int().min(0),
  // What the server called its own version then. Context only.
  serverVersion: z.string().nullable(),
  observedAt: z.string(),
  lastConfirmedAt: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(
    z.object({ name: z.string(), fields: z.array(marketMcpToolFieldSchema) }),
  ),
});
export type MarketMcpToolRevision = z.infer<typeof marketMcpToolRevisionSchema>;
export type MarketMcpToolsRevision = z.infer<typeof marketMcpToolsRevisionSchema>;

// GET /v1/mcp/:identifier/tools/revisions — newest first, for the one source
// whose tools the page shows (the answer's `source`; there is no way to ask for
// another). `before` is the revision number to continue after (the previous
// answer's `nextBefore`).
export const listMarketMcpToolRevisionsRequestSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MARKET_MCP_TOOL_REVISIONS_MAX_LIMIT)
    .default(MARKET_MCP_TOOL_REVISIONS_DEFAULT_LIMIT),
  // A revision number is a Postgres `integer`.
  before: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
});
export type ListMarketMcpToolRevisionsRequest = z.infer<
  typeof listMarketMcpToolRevisionsRequestSchema
>;

export const listMarketMcpToolRevisionsResponseSchema = z.object({
  source: marketMcpToolRevisionSourceSchema.nullable(),
  items: z.array(marketMcpToolRevisionSchema),
  nextBefore: z.number().int().min(1).nullable(),
});
export type ListMarketMcpToolRevisionsResponse = z.infer<
  typeof listMarketMcpToolRevisionsResponseSchema
>;

export const getMarketMcpResponseSchema = z.object({
  item: marketItemSummarySchema,
  versions: z.array(marketItemVersionSchema),
  // Null when the server has no published version to read it from. Optional
  // for answers from before it existed.
  readme: marketMcpReadmeSchema.nullable().optional(),
  // The latest version's AI-written overview (`?locale=`, English fallback);
  // null when there is none or a market admin hid it. Optional for answers
  // from before it existed.
  aiOverview: marketMcpAiOverviewSchema.nullable().optional(),
  // False when the page should stay out of search (`noindex`, not in the
  // sitemap): its README is one file that many servers show. Absent means
  // true, for answers from before it existed.
  searchIndexable: z.boolean().optional(),
  // The product group the server belongs to; null when no official server
  // exists for its brand. Optional for answers from before it existed.
  relatedProduct: marketMcpProductGroupSchema.nullable().optional(),
  // The latest version's quality scorecard (see `marketMcpScoreSchema`); null
  // when the server has no published version to score. Optional for answers
  // from before it existed.
  score: marketMcpScoreSchema.nullable().optional(),
  // The current revision of the source whose tool list is shown; null when
  // that list has no history. Optional for answers from before it existed.
  toolsRevision: marketMcpToolsRevisionSchema.nullable().optional(),
});

export const getMarketMcpManifestResponseSchema = z.object({
  item: marketItemSummarySchema,
  version: marketItemVersionSchema,
  manifest: marketMcpManifestSchema,
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

export type MarketItemStatus = z.infer<typeof marketItemStatusSchema>;
export type MarketItemVisibility = z.infer<typeof marketItemVisibilitySchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;
export type McpAuthPosture = z.infer<typeof mcpAuthPostureSchema>;
export type MarketMcpIconSource = z.infer<typeof marketMcpIconSourceSchema>;
export type MarketMcpAuthMethod = z.infer<typeof marketMcpAuthMethodSchema>;
export type McpRiskLevel = z.infer<typeof mcpRiskLevelSchema>;
export type McpRuntime = z.infer<typeof mcpRuntimeSchema>;
export type McpVerificationStatus = z.infer<typeof mcpVerificationStatusSchema>;
export type MarketMcpAuthRequirement = z.infer<
  typeof marketMcpAuthRequirementSchema
>;
export type MarketMcpPublisher = z.infer<typeof marketMcpPublisherSchema>;
export type MarketMcpToolManifest = z.infer<typeof marketMcpToolManifestSchema>;
export type MarketMcpOwnerField = z.infer<typeof marketMcpOwnerFieldSchema>;
export type MarketMcpOwnerLayer = z.infer<typeof marketMcpOwnerLayerSchema>;
export type MarketMcpManifest = z.infer<typeof marketMcpManifestSchema>;
export type MarketItemSummary = z.infer<typeof marketItemSummarySchema>;
export type MarketMcpProductGroupMember = z.infer<
  typeof marketMcpProductGroupMemberSchema
>;
export type MarketMcpProductGroup = z.infer<typeof marketMcpProductGroupSchema>;
export type MarketItemVersion = z.infer<typeof marketItemVersionSchema>;
export type ListMarketMcpRequest = z.infer<typeof listMarketMcpRequestSchema>;
export type ListMarketMcpResponse = z.infer<typeof listMarketMcpResponseSchema>;
export type McpReadmeStatus = z.infer<typeof mcpReadmeStatusSchema>;
export type MarketMcpReadmeSource = z.infer<typeof marketMcpReadmeSourceSchema>;
export type MarketMcpReadme = z.infer<typeof marketMcpReadmeSchema>;
export type McpStdioValidationReason = z.infer<
  typeof mcpStdioValidationReasonSchema
>;
export type MarketMcpValidation = z.infer<typeof marketMcpValidationSchema>;
export type MarketMcpToolsValidation = z.infer<
  typeof marketMcpToolsValidationSchema
>;
export type MarketMcpScoreItemKey = z.infer<typeof marketMcpScoreItemKeySchema>;
export type MarketMcpScoreGrade = z.infer<typeof marketMcpScoreGradeSchema>;
export type MarketMcpScoreItem = z.infer<typeof marketMcpScoreItemSchema>;
export type MarketMcpScore = z.infer<typeof marketMcpScoreSchema>;
export type MarketMcpLocale = z.infer<typeof marketMcpLocaleSchema>;
export type MarketMcpAiOverview = z.infer<typeof marketMcpAiOverviewSchema>;
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
  installRef: z.string().nullable().optional(),
  slug: z.string(),
  // The author's own short name for the skill (SKILL.md frontmatter `name`).
  name: z.string(),
  installName: z.string().optional(),
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
  // Actual visible overview languages for this version, without fallback.
  overviewLocales: z.array(z.enum(["en", "zh-CN", "zh-TW"])).optional(),
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
  // The slug of the public skill with the same files whose page this one
  // defers to in search (canonical, not in the sitemap); null when this skill
  // is that page. Optional for answers from before it existed.
  canonicalSlug: z.string().nullable().optional(),
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

// ---------------------------------------------------------------------------
// GitHub MCP Registry enrichment (Issue #367, W5)
// ---------------------------------------------------------------------------

// How a GitHub MCP Registry row was matched to a catalog entry: the same
// reverse-DNS name, or — for the brand servers GitHub lists under
// `owner/repo` — the same remote endpoint host, under the namespace's own
// domain, in a repository an organization owns.
export const marketMcpGithubRegistryMatchSchema = z.enum([
  "name",
  "endpoint-domain-org",
]);

// Where the daily pass keeps its record: `provenanceJson.githubRegistry` on
// the matched (latest published) version.
export const MARKET_MCP_GITHUB_REGISTRY_PROVENANCE_KEY = "githubRegistry";

// What the daily GitHub MCP Registry pass keeps on a matched version's
// provenance. Read by the logo chain (`ownerAvatarUrl`) and the scorecard
// (`license`, `stars`); the row's README is never taken. A row that disappears
// from GitHub leaves the record in place with its `fetchedAt`.
export const marketMcpGithubRegistryProvenanceSchema = z.object({
  // The row's name on GitHub (`com.notion/mcp` or `makenotion/notion-mcp-server`).
  name: z.string().min(1).max(200),
  matchedBy: marketMcpGithubRegistryMatchSchema,
  // Shown as an image on public pages: GitHub's avatar host only.
  ownerAvatarUrl: z
    .string()
    .url()
    .startsWith("https://avatars.githubusercontent.com/")
    .optional(),
  stars: z.number().int().min(0).optional(),
  license: z.string().min(1).max(120).optional(),
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(1000).optional(),
  fetchedAt: z.string(),
});

export type MarketMcpGithubRegistryMatch = z.infer<
  typeof marketMcpGithubRegistryMatchSchema
>;
export type MarketMcpGithubRegistryProvenance = z.infer<
  typeof marketMcpGithubRegistryProvenanceSchema
>;

export * from "./sitemaps";
export * from "./endpoint-pin";

// ---------------------------------------------------------------------------
// Owner-submitted tool lists (Issue #367, W7). `sourceweft mcp inspect` runs
// on the owner's machine, connects with their own credentials and writes this
// file; `sourceweft mcp submit-tools` uploads it. Credentials never leave the
// machine: the file carries the endpoint without its query string and no
// header, and the request below carries nothing else.
// ---------------------------------------------------------------------------

export const MARKET_MCP_INSPECT_LIMITS = Object.freeze({
  tools: 200,
  nameChars: 128,
  titleChars: 200,
  descriptionChars: 2_000,
  // One schema, as the CLI bounds it before writing the file.
  schemaBytes: 16 * 1024,
  // A tool's schemas and annotations together, as the platform accepts them
  // (the same figure the remote probe allows per tool).
  toolBytes: 32 * 1024,
  // The server's `initialize` self-description.
  serverInfoBytes: 4 * 1024,
});

/**
 * How deep a tool's schemas and annotations may nest. Real JSON Schemas stay
 * far below this; a value that fits the byte limit only as thousands of nested
 * arrays would overflow the stack of any recursive walk over it.
 */
export const MARKET_MCP_TOOL_MAX_NESTING = 64;

/**
 * Does any value nest deeper than `limit`? Walks with an explicit stack, so
 * the check cannot overflow on the input it rejects.
 */
export function marketMcpNestsDeeperThan(root: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (!value || typeof value !== "object") continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      stack.push([child, depth + 1]);
    }
  }
  return false;
}

// UTF-8 size of a value's JSON; this package runs in browsers too, so no
// Node `Buffer`.
function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
  } catch {
    // Nested too deeply to serialise: over any limit, not a server error.
    return Number.POSITIVE_INFINITY;
  }
}

export const marketMcpInspectedToolSchema = z
  .object({
    name: z.string().min(1).max(MARKET_MCP_INSPECT_LIMITS.nameChars),
    title: z.string().max(MARKET_MCP_INSPECT_LIMITS.titleChars).optional(),
    description: z
      .string()
      .max(MARKET_MCP_INSPECT_LIMITS.descriptionChars)
      .optional(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (tool) =>
      !marketMcpNestsDeeperThan(
        [tool.inputSchema, tool.outputSchema, tool.annotations],
        MARKET_MCP_TOOL_MAX_NESTING,
      ),
    {
      message: `A tool's schemas and annotations may nest at most ${MARKET_MCP_TOOL_MAX_NESTING} levels deep`,
    },
  )
  .refine(
    (tool) =>
      jsonBytes(tool.inputSchema) +
        jsonBytes(tool.outputSchema) +
        jsonBytes(tool.annotations) <=
      MARKET_MCP_INSPECT_LIMITS.toolBytes,
    {
      message: `A tool's schemas and annotations may take at most ${MARKET_MCP_INSPECT_LIMITS.toolBytes} bytes together`,
    },
  );

const marketMcpInspectServerInfoSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => jsonBytes(value) <= MARKET_MCP_INSPECT_LIMITS.serverInfoBytes,
    { message: `serverInfo may take at most ${MARKET_MCP_INSPECT_LIMITS.serverInfoBytes} bytes` },
  );
export type MarketMcpInspectedTool = z.infer<typeof marketMcpInspectedToolSchema>;

// What the file says it inspected, for the owner's own reference. The URL is
// the ORIGIN only: hosted MCP servers put per-user secrets in the path
// (`/api/mcp/s/<secret>/mcp`), and the query string and userinfo may carry a
// key. The command may carry a token too. Neither is ever uploaded.
export const marketMcpInspectTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url() }),
  z.object({ kind: z.literal("stdio"), command: z.string().min(1) }),
]);

export const marketMcpInspectFileSchema = z.object({
  schemaVersion: z.literal(1),
  generatedBy: z.string(),
  generatedAt: z.string(),
  target: marketMcpInspectTargetSchema,
  protocolVersion: z.string().optional(),
  serverInfo: marketMcpInspectServerInfoSchema.optional(),
  tools: z.array(marketMcpInspectedToolSchema).max(MARKET_MCP_INSPECT_LIMITS.tools),
});
export type MarketMcpInspectFile = z.infer<typeof marketMcpInspectFileSchema>;

// PUT /v1/market/mcp/:identifier/owner-overrides/tools — the owner's tool
// list from `sourceweft mcp inspect`: the tools, when they were listed and
// what the server called itself. The file's `target` stays on the owner's
// machine. The platform stores the tools with `risk: "unknown"` and
// `source: "owner-submitted"`.
export const submitMarketMcpOwnerToolsRequestSchema = z
  .object({
    tools: z
      .array(marketMcpInspectedToolSchema)
      .max(MARKET_MCP_INSPECT_LIMITS.tools),
    generatedAt: z.string().optional(),
    serverInfo: marketMcpInspectServerInfoSchema.optional(),
  })
  .strict();
export type SubmitMarketMcpOwnerToolsRequest = z.infer<
  typeof submitMarketMcpOwnerToolsRequestSchema
>;

// ---------------------------------------------------------------------------
// Platform reference snapshot (Issue #367). A market admin's private tool reads
// a server's tools with a reference account on its own machine and submits the
// list here. The platform records it as source `platform-indexed`, risk
// `unknown`; an owner's list outranks it.
// ---------------------------------------------------------------------------

export const MARKET_MCP_SNAPSHOT_LIMITS = Object.freeze({
  endpointChars: 2_048,
  // How far ahead of the server clock `observedAt` may be.
  clockSkewMs: 5 * 60 * 1000,
});

// POST /v1/market/admin/mcp/platform-snapshots
export const submitMarketMcpPlatformSnapshotRequestSchema = z
  .object({
    identifier: z.string().min(1).max(256),
    // Both must name the listing's CURRENT `manifest.endpointUrl`: the origin
    // as `scheme://host[:port]`, the URL in full. Compared after
    // normalisation (case, trailing dot, default port); userinfo is refused.
    endpointOrigin: z.string().min(1).max(MARKET_MCP_SNAPSHOT_LIMITS.endpointChars),
    endpointUrl: z.string().min(1).max(MARKET_MCP_SNAPSHOT_LIMITS.endpointChars),
    tools: z.array(marketMcpInspectedToolSchema).max(MARKET_MCP_INSPECT_LIMITS.tools),
    referenceProfile: marketMcpReferenceProfileSchema,
    // When the list was read, ISO 8601 with offset.
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SubmitMarketMcpPlatformSnapshotRequest = z.infer<
  typeof submitMarketMcpPlatformSnapshotRequestSchema
>;

export const submitMarketMcpPlatformSnapshotResponseSchema = z.object({
  identifier: z.string(),
  // `created`: a new revision; `confirmed`: same list as the latest revision,
  // only confirmed again; `throttled`: the daily revision ceiling was reached
  // and nothing was recorded.
  outcome: z.enum(["created", "confirmed", "throttled"]),
  revision: z.number().int().min(1).nullable(),
  toolsHash: z.string(),
  toolsCount: z.number().int().min(0),
});
export type SubmitMarketMcpPlatformSnapshotResponse = z.infer<
  typeof submitMarketMcpPlatformSnapshotResponseSchema
>;

// POST /v1/market/admin/mcp/tool-sources — take a source's recorded tools
// down (`takedown`: removes its whole history and keeps the source from being
// recorded again) or allow it again (`restore`).
export const marketMcpToolSourceActionRequestSchema = z
  .object({
    identifier: z.string().min(1).max(256),
    source: z.enum(["platform-indexed", "member-observed"]),
    action: z.enum(["takedown", "restore"]),
  })
  .strict();
export type MarketMcpToolSourceActionRequest = z.infer<
  typeof marketMcpToolSourceActionRequestSchema
>;
