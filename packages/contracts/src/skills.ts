import { z } from "zod";
import { capabilityOptionValueSchema } from "./capabilities";

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
});

export const skillManifestJsonSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  version: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
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
