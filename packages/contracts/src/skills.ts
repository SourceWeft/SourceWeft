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
  enabledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceInstalledSkillSchema = z.object({
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
  enabledAt: z.string().nullable(),
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
  sourceUrl: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  flagged: z.boolean().optional(),
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

export const listSkillsCatalogResponseSchema = z.object({
  items: z.array(skillCatalogItemSchema),
});

// GET /skills/registry/search?q= — relevance-ranked registry entries sharing the
// SkillCatalogItem shape (so the gallery reuses the same card). `q` < 2 chars
// returns an empty list server-side. docs/architecture/skill-registry-index.md §4.
export const searchRegistrySkillsResponseSchema = z.object({
  items: z.array(skillCatalogItemSchema),
  query: z.string(),
});

// POST /skills/registry/submit — one GitHub-URL intake. The authoritative URL
// parse (github.com allowlist + traversal stripping) is server-side, so the wire
// shape is deliberately just a non-empty string (skill-registry-index.md §3).
export const submitRegistrySkillRequestSchema = z
  .object({
    repoUrl: z.string().trim().min(1),
  })
  .strict();

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
  skillContent: z.string().nullable(),
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
export type ListSkillsCatalogResponse = z.infer<
  typeof listSkillsCatalogResponseSchema
>;
export type SearchRegistrySkillsResponse = z.infer<
  typeof searchRegistrySkillsResponseSchema
>;
export type SubmitRegistrySkillRequest = z.infer<
  typeof submitRegistrySkillRequestSchema
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

export const registryVersionSchema = z.object({
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
  skillContent: z.string().nullable(),
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
});
export type RegistryVersionDetail = z.infer<typeof registryVersionDetailSchema>;
export const switchSkillVersionSchema = z
  .object({ skillVersionId: z.string().min(1) })
  .strict();
