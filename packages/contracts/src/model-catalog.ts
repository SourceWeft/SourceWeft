import { z } from "zod";
import { imageModelCapabilitiesSchema, reasoningEffortSchema } from "./stream";
import { threadSchema } from "./threads";

export const modelCatalogKindSchema = z.enum(["llm", "image", "vision"]);

export const modelCatalogItemSchema = z.object({
  kind: modelCatalogKindSchema,
  profileAlias: z.string(),
  modelAlias: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  providerName: z.string().nullable(),
  providerKind: z.string().nullable(),
  targetModel: z.string().nullable(),
  availableViaGlobal: z.boolean().optional(),
  availableViaByokProviders: z.array(z.string()).optional(),
  displayName: z.string(),
  subtitle: z.string(),
  badges: z.array(z.string()),
  pricing: z.record(z.string(), z.unknown()).nullable(),
  capabilities: z
    .object({
      supportsThinking: z.boolean(),
      supportsImageInput: z.boolean().optional(),
      supportedParameters: z.array(z.string()),
      supportedEfforts: z.array(reasoningEffortSchema),
      reasoning: z.boolean(),
      reasoningEffort: z.boolean(),
      includeReasoning: z.boolean(),
      supportSources: z.array(z.string()),
      imageGeneration: imageModelCapabilitiesSchema.optional(),
    })
    .optional(),
});

export const listThreadModelCatalogResponseSchema = z.object({
  defaults: threadSchema.shape.modelSettings,
  kinds: z.object({
    llm: z.array(modelCatalogItemSchema),
    image: z.array(modelCatalogItemSchema),
    vision: z.array(modelCatalogItemSchema),
  }),
});

export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
export type ListThreadModelCatalogResponse = z.infer<
  typeof listThreadModelCatalogResponseSchema
>;
