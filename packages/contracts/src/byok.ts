import { z } from "zod";
import { modelCatalogKindSchema } from "./model-catalog";
import { reasoningEffortSchema } from "./stream";

export const byokCredentialSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  userId: z.string().nullable(),
  providerName: z.string(),
  providerKind: z.string(),
  baseUrl: z.string().nullable(),
  credentialAlias: z.string(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  isActive: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listByokCredentialsResponseSchema = z.object({
  items: z.array(byokCredentialSchema),
});

export const createByokCredentialRequestSchema = z.object({
  providerName: z.string().trim().min(1).max(100),
  credentialAlias: z.string().trim().min(1).max(256),
  apiKey: z.string().trim().min(1).max(4096),
  providerKind: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.string().trim().url().max(2048).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createByokCredentialResponseSchema = z.object({
  item: byokCredentialSchema,
});

export const deleteByokCredentialResponseSchema = z.object({
  deleted: z.literal(true),
  credentialId: z.string(),
});

export const byokProviderSchema = z.object({
  providerName: z.string(),
  providerKind: z.string(),
  baseUrl: z.string().nullable(),
  system: z.boolean(),
  isBYOKOnly: z.boolean().optional(),
  hasApiKey: z.boolean().optional(),
  credentialAliases: z.array(z.string()).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
});

export const listByokProvidersResponseSchema = z.object({
  items: z.array(byokProviderSchema),
});

export const resolveByokModelCapabilitiesRequestSchema = z.object({
  modelName: z.string().trim().min(1).max(256),
});

export const resolvedByokModelCapabilitiesSchema = z.object({
  supportsThinking: z.boolean(),
  supportsImageInput: z.boolean().optional(),
  supportedParameters: z.array(z.string()),
  supportedEfforts: z.array(reasoningEffortSchema),
  reasoning: z.boolean(),
  reasoningEffort: z.boolean(),
  includeReasoning: z.boolean(),
  supportSources: z.array(z.string()),
  maxCompletionTokens: z.number().nullable().optional(),
  litellmKey: z.string().optional(),
});

export const resolveByokModelCapabilitiesResponseSchema = z.object({
  capabilities: resolvedByokModelCapabilitiesSchema.nullable(),
});

export const byokModelCandidateSchema = z.object({
  modelId: z.string(),
  displayName: z.string(),
});

export const listByokModelCandidatesResponseSchema = z.object({
  items: z.array(byokModelCandidateSchema),
});

export const byokModelSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  userId: z.string().nullable(),
  providerName: z.string(),
  modelName: z.string(),
  displayName: z.string(),
  modelType: modelCatalogKindSchema,
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listByokModelsResponseSchema = z.object({
  items: z.array(byokModelSchema),
});

export const addByokModelRequestSchema = z.object({
  credentialId: z.string().trim().min(1).max(256),
  modelName: z.string().trim().min(1).max(512),
  displayName: z.string().trim().min(1).max(256).optional(),
  modelType: modelCatalogKindSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

export const addByokModelResponseSchema = z.object({
  item: byokModelSchema,
});

export const deleteByokModelResponseSchema = z.object({
  deleted: z.literal(true),
  modelId: z.string(),
});

export type ByokCredential = z.infer<typeof byokCredentialSchema>;
export type ByokModel = z.infer<typeof byokModelSchema>;
export type ByokProvider = z.infer<typeof byokProviderSchema>;
export type ListByokCredentialsResponse = z.infer<
  typeof listByokCredentialsResponseSchema
>;
export type ListByokModelsResponse = z.infer<
  typeof listByokModelsResponseSchema
>;
export type ByokModelCandidate = z.infer<typeof byokModelCandidateSchema>;
export type ListByokModelCandidatesResponse = z.infer<
  typeof listByokModelCandidatesResponseSchema
>;
export type ListByokProvidersResponse = z.infer<
  typeof listByokProvidersResponseSchema
>;
export type CreateByokCredentialRequest = z.infer<
  typeof createByokCredentialRequestSchema
>;
export type CreateByokCredentialResponse = z.infer<
  typeof createByokCredentialResponseSchema
>;
export type DeleteByokCredentialResponse = z.infer<
  typeof deleteByokCredentialResponseSchema
>;
export type ResolveByokModelCapabilitiesRequest = z.infer<
  typeof resolveByokModelCapabilitiesRequestSchema
>;
export type ResolveByokModelCapabilitiesResponse = z.infer<
  typeof resolveByokModelCapabilitiesResponseSchema
>;
export type AddByokModelRequest = z.infer<typeof addByokModelRequestSchema>;
export type AddByokModelResponse = z.infer<typeof addByokModelResponseSchema>;
export type DeleteByokModelResponse = z.infer<
  typeof deleteByokModelResponseSchema
>;
