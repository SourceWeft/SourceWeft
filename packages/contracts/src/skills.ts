import { z } from "zod";
import {
  capabilityOptionModelValuesSchema,
  capabilityOptionValueSchema,
} from "./capabilities";

const skillSlashConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

export const skillRuntimeConfigSelectionSchema = z.record(
  z.string().trim().min(1).max(128),
  z.record(z.string(), z.unknown()),
);

const skillSourceTypeSchema = z.enum([
  "builtin",
  "workspace_custom",
  "team_custom",
  // GitHub registry index entries: pointer + metadata only, content fetched
  // on-use (docs/architecture/skill-registry-index.md §0).
  "registry_github",
]);

export const skillLogoSchema = z.object({
  url: z.string().max(100_000).refine((value) => {
    if (/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  }, "Expected an HTTPS image URL or a PNG thumbnail"),
  source: z.enum(["skill", "publisher"]),
  path: z.string().optional(),
});
export type SkillLogo = z.infer<typeof skillLogoSchema>;

export const skillCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  canonicalName: z.string(),
  displayName: z.string(),
  description: z.string(),
  path: z.string(),
  argumentHint: z.string().optional(),
  title: z.string().optional(),
  skillSlugs: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  slash: z.boolean().optional(),
});

const skillOptionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    valueType: z.enum(["string", "number", "boolean"]),
    defaultValue: capabilityOptionValueSchema.optional(),
    target: z.object({
      toolName: z.string().optional(),
      path: z.string(),
    }),
    // See capabilityToolOptionSchema in stream.ts — same pointer, same reason:
    // a skill-targeted option is narrowed by the selected model too, and the
    // composer must not have to know which option that applies to.
    modelValues: capabilityOptionModelValuesSchema.optional(),
    values: z.array(
      z.object({
        value: capabilityOptionValueSchema,
        label: z.string().optional(),
      }),
    ),
  })
  .strict();

export const workspaceSkillSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  skillId: z.string(),
  skillVersionId: z.string(),
  enabled: z.boolean(),
  configJson: z.record(z.string(), z.unknown()),
  enabledBy: z.string().nullable(),
  // `agent`: the chat agent installed it on its own initiative.
  installedVia: z.enum(["user", "agent"]).default("user"),
  enabledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceInstalledSkillSchema = z.object({
  logo: skillLogoSchema.optional(),
  workspaceSkillId: z.string(),
  selectionId: z.string(),
  catalogId: z.string(),
  sourceType: skillSourceTypeSchema,
  skillId: z.string(),
  skillVersionId: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  categories: z.array(z.string()),
  enabled: z.boolean(),
  configJson: z.record(z.string(), z.unknown()),
  enabledBy: z.string().nullable(),
  // `agent`: the chat agent installed it on its own initiative.
  installedVia: z.enum(["user", "agent"]).default("user"),
  enabledAt: z.string().nullable(),
  // An install pins one version. `currentVersionId` is the skill's published
  // current version (null while there is none, e.g. the newest one is still
  // under review); `updateAvailable` says it is not the pinned one. Optional so
  // an older API answering a newer client reads as "no update", never as an
  // error.
  currentVersionId: z.string().nullable().optional(),
  updateAvailable: z.boolean().optional(),
  // Registry entries only: whether the bundle ships runnable scripts. Surfaced
  // because an `executable` skill installs DISABLED — the UI has to be able to
  // say WHY it is off, or a skill the user asked for looks broken rather than
  // deliberately held back. See skills/agent-tools.ts.
  registryCapability: z.enum(["prompt-only", "executable"]).optional(),
  capabilities: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  models: z
    .object({
      chat: z.string().optional(),
      image: z.string().optional(),
      vision: z.string().optional(),
    })
    .optional(),
  commands: z.array(skillCommandSchema).optional(),
  tools: z.array(z.string()).optional(),
  options: z.array(skillOptionSchema).optional(),
  slash: z.boolean().optional(),
  slashConfig: skillSlashConfigSchema.optional(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const skillCatalogItemSchema = z.object({
  logo: skillLogoSchema.optional(),
  catalogId: z.string(),
  selectionId: z.string().nullable(),
  sourceType: skillSourceTypeSchema,
  skillId: z.string(),
  skillVersionId: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  categories: z.array(z.string()),
  enabledWorkspaceSkillId: z.string().nullable(),
  enabled: z.boolean(),
  installable: z.boolean(),
  defaultEnabled: z.boolean().optional(),
  hasReadme: z.boolean(),
  capabilities: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  models: z
    .object({
      chat: z.string().optional(),
      image: z.string().optional(),
      vision: z.string().optional(),
    })
    .optional(),
  commands: z.array(skillCommandSchema).optional(),
  tools: z.array(z.string()).optional(),
  options: z.array(skillOptionSchema).optional(),
  slash: z.boolean().optional(),
  slashConfig: skillSlashConfigSchema.optional(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
  // Registry (`sourceType='registry_github'`) attribution + trust surface,
  // populated only for registry entries (undefined otherwise). `publisher` is
  // "Community"; `verified` is always false (trust firewall — never
  // self-asserted); `flagged` reflects the ingest scan's reviewRequired;
  // `sourceUrl`/`license` satisfy index-level attribution.
  // docs/architecture/skill-registry-index.md §0/§5.5.
  publisher: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  // A featured publisher's skill (community entries only).
  featured: z.boolean().optional(),
  sourceUrl: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  flagged: z.boolean().optional(),
  // Market surface of a community skill (undefined for builtins and a
  // workspace's own skills). For these entries `categories` holds the market's
  // category slugs and `verified` is the market admin's grant.
  installCount: z.number().int().nonnegative().optional(),
  // GitHub stars of the repository the skill comes from; 0 when not known yet.
  repoStars: z.number().int().nonnegative().optional(),
  // When the skill first went public; null while it is not listed.
  listedAt: z.string().nullable().optional(),
  capability: z.enum(["prompt-only", "executable"]).nullable().optional(),
});

export const skillManifestJsonSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  version: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  defaultEnabled: z.boolean().optional(),
  categories: z.array(z.string()),
  capabilities: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  models: z
    .object({
      chat: z.string().optional(),
      image: z.string().optional(),
      vision: z.string().optional(),
    })
    .optional(),
  commands: z.array(skillCommandSchema).optional(),
  tools: z.array(z.string()).optional(),
  options: z.array(skillOptionSchema).optional(),
  slash: z.boolean().optional(),
  slashConfig: skillSlashConfigSchema.optional(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
});

export const SKILLS_CATALOG_DEFAULT_PAGE_SIZE = 50;
export const SKILLS_CATALOG_MAX_PAGE_SIZE = 100;

// GET /skills/catalog?limit=&cursor=&q= — query params arrive as strings, hence
// the coercion. `limit` sizes the page of community (registry) skills only: the
// rest of the catalog (builtins, the workspace's and team's own skills) is a
// small bounded set returned whole on the first page. `cursor` is the opaque
// `nextCursor` of the previous page.
// `recommended` = featured publishers first, then verified, then the rank score
// (installs and GitHub stars, `market/rank.ts`), then newest. `stars` = the
// source repository's GitHub stars.
export const skillCatalogSortSchema = z.enum([
  "recommended",
  "popular",
  "new",
  "name",
  "stars",
]);
export type SkillCatalogSort = z.infer<typeof skillCatalogSortSchema>;
// `builtin` = ours; `featured` = from a publisher the platform highlights;
// `verified` = a market admin vouched for it; `community` = everything else
// anyone imported (neither featured nor verified).
export const skillCatalogTrustSchema = z.enum([
  "all",
  "builtin",
  "featured",
  "verified",
  "community",
]);
export type SkillCatalogTrust = z.infer<typeof skillCatalogTrustSchema>;
export const skillCatalogCapabilitySchema = z.enum([
  "all",
  "prompt-only",
  "executable",
]);
export type SkillCatalogCapability = z.infer<
  typeof skillCatalogCapabilitySchema
>;
export const skillCatalogInstalledSchema = z.enum([
  "all",
  "installed",
  "not_installed",
]);
export type SkillCatalogInstalled = z.infer<typeof skillCatalogInstalledSchema>;

export const listSkillsCatalogQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SKILLS_CATALOG_MAX_PAGE_SIZE)
    .default(SKILLS_CATALOG_DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(1024).optional(),
  q: z.string().trim().max(200).optional(),
  // Market filters, all applied in SQL so a page is `limit` matching skills —
  // not `limit` skills of which some match.
  category: z.string().trim().min(1).max(64).optional(),
  trust: skillCatalogTrustSchema.default("all"),
  capability: skillCatalogCapabilitySchema.default("all"),
  installed: skillCatalogInstalledSchema.default("all"),
  // Orders the community skills. A cursor is only good for the sort that
  // produced it; the server answers INVALID_CURSOR otherwise.
  sort: skillCatalogSortSchema.default("recommended"),
});

export const listSkillsCatalogResponseSchema = z.object({
  items: z.array(skillCatalogItemSchema),
  // null once the last page has been served.
  nextCursor: z.string().nullable(),
  // How many community skills match the query and filters in all, whatever
  // page this is. Absent when the filters rule community skills out, and from
  // servers that predate it.
  registryTotal: z.number().int().nonnegative().optional(),
});

// GET /skills/catalog/categories — the market's categories with how many
// community skills this viewer would find under each. Categories with none are
// included (count 0) so the list does not reshuffle as the catalog grows.
export const skillCatalogCategorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  count: z.number().int().nonnegative(),
});
export type SkillCatalogCategory = z.infer<typeof skillCatalogCategorySchema>;
export const listSkillCatalogCategoriesResponseSchema = z.object({
  items: z.array(skillCatalogCategorySchema),
});
export type ListSkillCatalogCategoriesResponse = z.infer<
  typeof listSkillCatalogCategoriesResponseSchema
>;

// Market admin: a community skill's standing on the public market.
// GET /v1/skills/registry/admin/skills/:skillId/market, and the body every
// market admin action answers with.
export const skillMarketStandingSchema = z.object({
  skillId: z.string(),
  slug: z.string(),
  visibility: z.enum(["public", "restricted"]),
  // Held: the auto-listing pass leaves it alone.
  listingHold: z.boolean(),
  // Who holds it — an admin withdrew it, or its owner keeps it private.
  listingHoldBy: z.enum(["admin", "owner"]).nullable(),
  verified: z.boolean(),
  // Featured publisher, and who set it: the platform's import, or an admin
  // (whose choice an import never overwrites).
  featured: z.boolean().default(false),
  featuredSetBy: z.enum(["sync", "admin"]).nullable().default(null),
  categorySlugs: z.array(z.string()),
  // Who chose the categories: inferred from the skill's text (`auto`, or null
  // for a skill filed before this was recorded), or picked by an admin — which
  // a bulk re-inference leaves alone.
  // Optional in the type so standings built before these existed still fit;
  // the API always sends them.
  categoriesSetBy: z.enum(["auto", "admin"]).nullable().optional(),
  // Visible reviews, as the upkeep last counted them; `ratingAvg` is null
  // while there are none.
  ratingCount: z.number().int().nonnegative().optional(),
  ratingAvg: z.number().nullable().optional(),
  installCount: z.number().int().nonnegative(),
  listedAt: z.string().nullable(),
});
export type SkillMarketStanding = z.infer<typeof skillMarketStandingSchema>;

// Why a skill is in the admin's listing queue:
// - `flagged`: published with an advisory scan flag and not public yet.
// - `new-version-flags` / `new-version-scripts`: already public, and its
//   current version brought scan flags or scripts the version before it did
//   not have. It stays public; the admin keeps it (acknowledges the version)
//   or withdraws it.
export const skillListingQueueReasonSchema = z.enum([
  "flagged",
  "new-version-flags",
  "new-version-scripts",
]);
export type SkillListingQueueReason = z.infer<
  typeof skillListingQueueReasonSchema
>;
// POST /v1/skills/registry/admin/listing-queue/:versionId/acknowledge — the
// admin keeps a public skill whose new version entered the queue.
export const acknowledgeSkillVersionResponseSchema = z.object({
  skillId: z.string(),
  skillVersionId: z.string(),
  acknowledgedAt: z.string(),
});
export type AcknowledgeSkillVersionResponse = z.infer<
  typeof acknowledgeSkillVersionResponseSchema
>;

// Editorial collections on the public market, as the market admin manages
// them under /v1/skills/registry/admin/collections.
export const skillCollectionSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, digits and dashes");
export const skillCollectionAdminItemSchema = z.object({
  skillId: z.string(),
  slug: z.string(),
  displayName: z.string(),
  position: z.number().int(),
  // On the public market right now. Only these show on the public page.
  public: z.boolean(),
});
export const skillCollectionAdminSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  position: z.number().int(),
  published: z.boolean(),
  items: z.array(skillCollectionAdminItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SkillCollectionAdmin = z.infer<typeof skillCollectionAdminSchema>;
export const listSkillCollectionsAdminResponseSchema = z.object({
  items: z.array(skillCollectionAdminSchema),
});
export const createSkillCollectionRequestSchema = z
  .object({
    slug: skillCollectionSlugSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(500).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    published: z.boolean().optional(),
  })
  .strict();
export type CreateSkillCollectionRequest = z.infer<
  typeof createSkillCollectionRequestSchema
>;
export const updateSkillCollectionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    summary: z.string().trim().max(500).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    published: z.boolean().optional(),
  })
  .strict();
export type UpdateSkillCollectionRequest = z.infer<
  typeof updateSkillCollectionRequestSchema
>;
// The collection's skills, in order, by slug. Replaces what was there.
export const setSkillCollectionItemsRequestSchema = z
  .object({ slugs: z.array(z.string().trim().min(1).max(256)).max(100) })
  .strict();
// GET|PUT /skills/catalog/:catalogId/listing — the OWNER's say over whether a
// community skill they imported may be on the public market. 404 for anyone
// else. `listed: true` only lifts the owner's own hold; whether the skill then
// lists is decided the usual way (clean → listed, flagged → admin's queue).
export const ownerSkillListingSchema = z.object({
  skillId: z.string(),
  // On the public market right now.
  listed: z.boolean(),
  heldBy: z.enum(["admin", "owner"]).nullable(),
});
export type OwnerSkillListing = z.infer<typeof ownerSkillListingSchema>;
export const setOwnerSkillListingRequestSchema = z
  .object({ listed: z.boolean() })
  .strict();

export const setSkillMarketFeaturedRequestSchema = z
  .object({ featured: z.boolean() })
  .strict();

export const setSkillMarketVerifiedRequestSchema = z
  .object({ verified: z.boolean() })
  .strict();
export const setSkillMarketCategoriesRequestSchema = z
  .object({ categorySlugs: z.array(z.string().min(1).max(64)).min(1).max(5) })
  .strict();

// GET /skills/registry/search?q= — relevance-ranked registry entries sharing the
// SkillCatalogItem shape (so the gallery reuses the same card). `q` < 2 chars
// returns an empty list server-side. docs/architecture/skill-registry-index.md §4.
export const searchRegistrySkillsResponseSchema = z.object({
  items: z.array(skillCatalogItemSchema),
  query: z.string(),
});

// `indexed` = clean scan → auto-published catalog entry; `queued` = flagged or
// sticky (§4 triage) → held for review. `slug` is the derived collision-safe key.
export const skillDiagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  file: z.string().optional(),
  field: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>;
export const registrySkillResultSchema = z.object({
  sourcePath: z.string(),
  name: z.string().optional(),
  slug: z.string().optional(),
  skillVersionId: z.string().optional(),
  version: z.string().optional(),
  status: z.enum(["indexed", "queued", "failed"]),
  flags: z.array(z.string()),
  diagnostics: z.array(skillDiagnosticSchema),
});
export type RegistrySkillResult = z.infer<typeof registrySkillResultSchema>;
// The ingest core's summary of one source (backend `registry/submit.ts`). No
// endpoint returns it any more — submissions carry the per-skill results.
export const submitRegistrySkillResponseSchema = z.object({
  status: z.enum(["indexed", "queued"]),
  slug: z.string().optional(),
  skills: z.array(registrySkillResultSchema),
});

export const listWorkspaceSkillsResponseSchema = z.object({
  items: z.array(workspaceInstalledSkillSchema),
});

export const getSkillCatalogDetailResponseSchema = z.object({
  skill: skillCatalogItemSchema,
  readmeContent: z.string().nullable(),
  readmePath: z.string().nullable(),
  skillContent: z.string().nullable(),
  // true when `readmeContent`/`skillContent` are null because this viewer does
  // not get a community skill's full text — it goes to a workspace that
  // installed the skill, to its submitter and to market admins. The listing
  // (`skill`, with its `sourceUrl`) is complete either way.
  contentRestricted: z.boolean().optional(),
});

export const enableWorkspaceSkillRequestSchema = z
  .object({
    skillId: z.string().trim().min(1).max(128),
    skillVersionId: z.string().trim().min(1).max(128),
    configJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const enableWorkspaceSkillResponseSchema = z.object({
  workspaceSkill: workspaceSkillSchema,
});

export const updateWorkspaceSkillRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    configJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const updateWorkspaceSkillResponseSchema = z.object({
  workspaceSkill: workspaceSkillSchema,
});

export const deleteWorkspaceSkillResponseSchema = z.object({
  deleted: z.literal(true),
  workspaceSkillId: z.string(),
});

const customSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const customSkillVersionLabelSchema = z.string().trim().min(1).max(64);

export const customSkillDefinitionSchema = z.object({
  id: z.string(),
  teamId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  sourceType: skillSourceTypeSchema,
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  status: z.enum(["active", "archived"]),
  ownerUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const customSkillVersionSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  version: z.string(),
  status: z.enum(["draft", "published", "deprecated", "disabled"]),
  storageType: z.enum(["repo_builtin", "db_text"]),
  storagePointer: z.string(),
  isCurrent: z.boolean(),
  contentHash: z.string(),
  manifestJson: skillManifestJsonSchema,
  createdBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const customSkillVersionFileSchema = z.object({
  id: z.string(),
  skillVersionId: z.string(),
  path: z.string(),
  contentText: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  createdAt: z.string(),
});

export const customSkillSchema = z.object({
  definition: customSkillDefinitionSchema,
  version: customSkillVersionSchema,
});

export const createCustomSkillRequestSchema = z
  .object({
    name: customSkillNameSchema,
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().min(1).max(1024),
    version: customSkillVersionLabelSchema.optional(),
  })
  .strict();

export const createCustomSkillVersionRequestSchema = z
  .object({
    version: customSkillVersionLabelSchema,
  })
  .strict();

export const updateCustomSkillVersionRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();

export const putCustomSkillVersionFileRequestSchema = z
  .object({
    contentText: z.string().max(256 * 1024),
    mimeType: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const customSkillResponseSchema = z.object({
  customSkill: customSkillSchema,
});

export const putCustomSkillVersionFileResponseSchema = z.object({
  file: customSkillVersionFileSchema,
});

export const deleteCustomSkillVersionFileResponseSchema = z.object({
  deleted: z.literal(true),
  path: z.string(),
});

export type SkillOption = z.infer<typeof skillOptionSchema>;
export type SkillCommand = z.infer<typeof skillCommandSchema>;
export type WorkspaceSkill = z.infer<typeof workspaceSkillSchema>;
export type WorkspaceInstalledSkill = z.infer<
  typeof workspaceInstalledSkillSchema
>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
// What a client passes; the schema above is the server's parse of the same
// fields off the query string.
export type ListSkillsCatalogParams = {
  limit?: number;
  cursor?: string;
  q?: string;
  category?: string;
  trust?: SkillCatalogTrust;
  capability?: SkillCatalogCapability;
  installed?: SkillCatalogInstalled;
  sort?: SkillCatalogSort;
};
export type ListSkillsCatalogResponse = z.infer<
  typeof listSkillsCatalogResponseSchema
>;
export type SearchRegistrySkillsResponse = z.infer<
  typeof searchRegistrySkillsResponseSchema
>;
export type SubmitRegistrySkillResponse = z.infer<
  typeof submitRegistrySkillResponseSchema
>;
export type ListWorkspaceSkillsResponse = z.infer<
  typeof listWorkspaceSkillsResponseSchema
>;
export type GetSkillCatalogDetailResponse = z.infer<
  typeof getSkillCatalogDetailResponseSchema
>;
export type EnableWorkspaceSkillRequest = z.infer<
  typeof enableWorkspaceSkillRequestSchema
>;
export type EnableWorkspaceSkillResponse = z.infer<
  typeof enableWorkspaceSkillResponseSchema
>;
export type UpdateWorkspaceSkillRequest = z.infer<
  typeof updateWorkspaceSkillRequestSchema
>;
export type UpdateWorkspaceSkillResponse = z.infer<
  typeof updateWorkspaceSkillResponseSchema
>;
export type DeleteWorkspaceSkillResponse = z.infer<
  typeof deleteWorkspaceSkillResponseSchema
>;
export type CustomSkillDefinition = z.infer<typeof customSkillDefinitionSchema>;
export type CustomSkillVersion = z.infer<typeof customSkillVersionSchema>;
export type CustomSkillVersionFile = z.infer<
  typeof customSkillVersionFileSchema
>;
export type CustomSkill = z.infer<typeof customSkillSchema>;
export type CreateCustomSkillRequest = z.infer<
  typeof createCustomSkillRequestSchema
>;
export type CreateCustomSkillVersionRequest = z.infer<
  typeof createCustomSkillVersionRequestSchema
>;
export type UpdateCustomSkillVersionRequest = z.infer<
  typeof updateCustomSkillVersionRequestSchema
>;
export type PutCustomSkillVersionFileRequest = z.infer<
  typeof putCustomSkillVersionFileRequestSchema
>;
export type CustomSkillResponse = z.infer<typeof customSkillResponseSchema>;
export type PutCustomSkillVersionFileResponse = z.infer<
  typeof putCustomSkillVersionFileResponseSchema
>;
export type DeleteCustomSkillVersionFileResponse = z.infer<
  typeof deleteCustomSkillVersionFileResponseSchema
>;

// What changed from one published version of a community skill to the next
// (`market/changelog.ts`): files by path and content hash, scripts and scan
// flags the newer one adds, and GitHub's own comparison of the two commits.
export const skillVersionChangelogSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(z.string()),
  newScripts: z.array(z.string()),
  newFlags: z.array(z.string()),
  compareUrl: z.string().nullable(),
});
export type SkillVersionChangelog = z.infer<typeof skillVersionChangelogSchema>;

export const registryVersionSchema = z.object({
  logo: skillLogoSchema.optional(),
  id: z.string(),
  skillId: z.string(),
  version: z.string(),
  status: z.enum(["draft", "published", "deprecated", "disabled"]),
  isCurrent: z.boolean(),
  displayName: z.string(),
  description: z.string(),
  sourceUrl: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  flags: z.array(z.string()),
  diagnostics: z.array(skillDiagnosticSchema),
  findings: z.array(
    z.object({
      ruleId: z.string(),
      file: z.string().optional(),
      line: z.number().optional(),
    }),
  ),
  hasIngestion: z.boolean(),
  moderation: z
    .object({
      action: z.enum(["publish", "reject", "revoke"]),
      actorUserId: z.string(),
      at: z.string(),
      reason: z.string().optional(),
    })
    .nullable(),
});
export type RegistryVersion = z.infer<typeof registryVersionSchema>;
export const registryVersionsResponseSchema = z.object({
  items: z.array(registryVersionSchema),
  nextCursor: z.string().nullable(),
  installed: z
    .object({
      id: z.string(),
      skillVersionId: z.string(),
      enabled: z.boolean(),
    })
    .nullable(),
});
export type RegistryVersionsResponse = z.infer<
  typeof registryVersionsResponseSchema
>;
export const registryVersionDetailSchema = z.object({
  version: registryVersionSchema,
  readmeContent: z.string().nullable(),
  readmePath: z.string().nullable(),
  skillContent: z.string().nullable(),
  // Same rule as `getSkillCatalogDetailResponseSchema.contentRestricted`.
  contentRestricted: z.boolean().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      contentHash: z.string(),
      sizeBytes: z.number(),
    }),
  ),
  changes: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
  }),
  // The same comparison with the previous published version, plus what it
  // means for trust — scripts and scan flags this version adds — and a GitHub
  // compare link. Null for the first version.
  changelog: skillVersionChangelogSchema.nullable().optional(),
});
export type RegistryVersionDetail = z.infer<typeof registryVersionDetailSchema>;
export const switchSkillVersionSchema = z
  .object({
    skillVersionId: z.string().min(1),
    // Required to move an install to a version that adds executable scripts or
    // new scan flags; without it the API answers 409 SKILL_VERSION_ESCALATION
    // with what escalates, so the client can ask and retry.
    acknowledgeEscalation: z.boolean().optional(),
  })
  .strict();

// --- Asynchronous registry submissions ---------------------------------------
// A submission is the progress + outcome record of one background ingest. The
// client creates it, then polls it: `stage`/`stages` say where the worker is,
// `results` say what happened to each skill once it is done.
export const skillSubmissionStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type SkillSubmissionStatus = z.infer<typeof skillSubmissionStatusSchema>;
export const skillSubmissionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  // `GITHUB_RATE_LIMITED`: GitHub's rate limit is spent. On a `queued`
  // submission it is waiting and runs again at `resumeAt` (ISO 8601); on a
  // `failed` one it waited as long as it may.
  resumeAt: z.string().optional(),
});
/** The submission is waiting for GitHub's rate limit to lift (see `resumeAt`). */
export const SKILL_SUBMISSION_RATE_LIMITED_CODE = "GITHUB_RATE_LIMITED";
export const skillSubmissionStageSchema = z.object({
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: skillSubmissionErrorSchema.optional(),
});
export const skillSubmissionSkillResultSchema = registrySkillResultSchema.extend(
  {
    // Present only when the submission asked for an install on completion.
    install: z
      .object({
        // `skipped`: held for review, so nothing published to install yet.
        status: z.enum(["installed", "already_installed", "skipped", "failed"]),
        error: skillSubmissionErrorSchema.optional(),
      })
      .optional(),
  },
);
export type SkillSubmissionSkillResult = z.infer<
  typeof skillSubmissionSkillResultSchema
>;
export const skillSubmissionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  submittedBy: z.string(),
  sourceKind: z.enum(["github", "upload"]),
  sourceInput: z.string(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  ref: z.string().nullable(),
  subpath: z.string().nullable(),
  commitSha: z.string().nullable(),
  commitCommittedAt: z.string().nullable(),
  target: z.enum(["workspace", "team"]),
  status: skillSubmissionStatusSchema,
  stage: z.string().nullable(),
  // Keyed by stage name; the server emits the keys in execution order.
  stages: z.record(z.string(), skillSubmissionStageSchema),
  results: z.array(skillSubmissionSkillResultSchema),
  onComplete: z
    .object({
      install: z
        .object({
          skill: z.string().optional(),
          installedVia: z.enum(["user", "agent"]).optional(),
        })
        .optional(),
    })
    .nullable(),
  error: skillSubmissionErrorSchema.nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type SkillSubmission = z.infer<typeof skillSubmissionSchema>;
/**
 * `source` is deliberately just a non-empty string, not a URL schema: the
 * server's GitHub source parser is the authority (github.com allowlist,
 * traversal stripping) and also accepts the `owner/repo` shorthand.
 */
export const createSkillSubmissionRequestSchema = z
  .object({
    source: z.string().trim().min(1).max(2048),
    // Install what gets indexed into this workspace once the ingest finishes;
    // `skill` narrows a multi-skill repository to one, by name or slug.
    install: z
      .object({ skill: z.string().trim().min(1).max(256).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type CreateSkillSubmissionRequest = z.infer<
  typeof createSkillSubmissionRequestSchema
>;
export const skillSubmissionResponseSchema = z.object({
  submission: skillSubmissionSchema,
});
export type SkillSubmissionResponse = z.infer<
  typeof skillSubmissionResponseSchema
>;
export const listSkillSubmissionsResponseSchema = z.object({
  items: z.array(skillSubmissionSchema),
  nextCursor: z.string().nullable(),
});
export type ListSkillSubmissionsResponse = z.infer<
  typeof listSkillSubmissionsResponseSchema
>;
