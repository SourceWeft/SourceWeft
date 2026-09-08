import { z } from "zod";

/**
 * A chat-able agent persona a workspace may start a thread with. Shaped after
 * deepagents' `SubAgent` declaration: the same fields describe a `task`
 * delegate and a persona that owns a thread of its own.
 */
export const personaTrustSchema = z.enum(["system", "user"]);

export const personaModelSettingsSchema = z
  .object({
    llmProfileAlias: z.string().nullable().optional(),
    llmModelAlias: z.string().nullable().optional(),
  })
  .strip();

export const personaSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  avatar: z.string().nullable(),
  trust: personaTrustSchema,
  modelSettings: personaModelSettingsSchema.nullable(),
  /** Null = the persona inherits the thread's normal tool set. */
  toolAllowlist: z.array(z.string()).nullable(),
});

export const listPersonasResponseSchema = z.object({
  items: z.array(personaSchema),
});

export type PersonaTrust = z.infer<typeof personaTrustSchema>;
export type Persona = z.infer<typeof personaSchema>;
export type ListPersonasResponse = z.infer<typeof listPersonasResponseSchema>;
