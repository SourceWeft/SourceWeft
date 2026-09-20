import { z } from "zod";

/**
 * A chat-able agent persona a workspace may start a thread with. Shaped after
 * deepagents' `SubAgent` declaration: the same fields describe a `task`
 * delegate and a persona that owns a thread of its own.
 *
 * `system` personas ship with the product and are read-only; `user` personas
 * are workspace-authored by cloning one and editing the copy.
 */
export const personaTrustSchema = z.enum(["system", "user"]);

/** `read_only` keeps a persona (or a clone of one) from writing files. */
export const personaFilesystemPolicySchema = z.enum(["default", "read_only"]);

export const personaModelSettingsSchema = z
  .object({
    llmProfileAlias: z.string().nullable().optional(),
    llmModelAlias: z.string().nullable().optional(),
  })
  .strip();

export const personaSchema = z.object({
  /** Stable id: the built-in slug, or the workspace persona's row id. */
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  avatar: z.string().nullable(),
  trust: personaTrustSchema,
  modelSettings: personaModelSettingsSchema.nullable(),
  /** Null = the persona inherits the thread's normal tool set. */
  toolAllowlist: z.array(z.string()).nullable(),
  filesystemPolicy: personaFilesystemPolicySchema.default("default"),
  /** For a workspace persona: what it was cloned from (slug or persona id). */
  clonedFrom: z.string().nullable().default(null),
  createdBy: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});

export const listPersonasResponseSchema = z.object({
  items: z.array(personaSchema),
  /** The business tool names a persona's allowlist may reference. */
  availableTools: z.array(z.string()).default([]),
});

const personaNameSchema = z.string().trim().min(1).max(80);
const personaDescriptionSchema = z.string().trim().max(500);
const personaSystemPromptSchema = z.string().trim().min(1).max(20_000);
const personaToolAllowlistSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(64)
  .nullable();

const personaOverridesShape = {
  name: personaNameSchema.optional(),
  description: personaDescriptionSchema.optional(),
  systemPrompt: personaSystemPromptSchema.optional(),
  modelSettings: personaModelSettingsSchema.nullable().optional(),
  toolAllowlist: personaToolAllowlistSchema.optional(),
  filesystemPolicy: personaFilesystemPolicySchema.optional(),
};

/**
 * A workspace persona is always created from a source — a built-in slug or
 * another workspace persona id — with optional edits applied to the copy.
 */
export const createPersonaRequestSchema = z.object({
  sourceId: z.string().trim().min(1).max(128),
  ...personaOverridesShape,
});

export const updatePersonaRequestSchema = z
  .object(personaOverridesShape)
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    { message: "At least one persona field must be provided" },
  );

export const personaResponseSchema = z.object({
  persona: personaSchema,
});

export const deletePersonaResponseSchema = z.object({
  deleted: z.literal(true),
  personaId: z.string(),
});

export type PersonaTrust = z.infer<typeof personaTrustSchema>;
export type PersonaFilesystemPolicy = z.infer<
  typeof personaFilesystemPolicySchema
>;
export type Persona = z.infer<typeof personaSchema>;
export type ListPersonasResponse = z.infer<typeof listPersonasResponseSchema>;
export type CreatePersonaRequest = z.infer<typeof createPersonaRequestSchema>;
export type UpdatePersonaRequest = z.infer<typeof updatePersonaRequestSchema>;
export type PersonaResponse = z.infer<typeof personaResponseSchema>;
export type DeletePersonaResponse = z.infer<typeof deletePersonaResponseSchema>;
