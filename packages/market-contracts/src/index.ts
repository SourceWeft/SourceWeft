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
  category: z.string().optional(),
  transport: mcpTransportSchema.optional(),
  official: z.boolean().optional(),
  verified: z.boolean().optional(),
  runtime: mcpRuntimeSchema.optional(),
  includeDesktopOnly: z.boolean().optional(),
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

export type MarketItemKind = z.infer<typeof marketItemKindSchema>;
export type MarketItemStatus = z.infer<typeof marketItemStatusSchema>;
export type MarketItemVisibility = z.infer<typeof marketItemVisibilitySchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;
export type McpRiskLevel = z.infer<typeof mcpRiskLevelSchema>;
export type McpRuntime = z.infer<typeof mcpRuntimeSchema>;
export type McpVerificationStatus = z.infer<
  typeof mcpVerificationStatusSchema
>;
export type MarketMcpAuthRequirement = z.infer<
  typeof marketMcpAuthRequirementSchema
>;
export type MarketMcpToolManifest = z.infer<
  typeof marketMcpToolManifestSchema
>;
export type MarketMcpManifest = z.infer<typeof marketMcpManifestSchema>;
export type MarketItemSummary = z.infer<typeof marketItemSummarySchema>;
export type MarketItemVersion = z.infer<typeof marketItemVersionSchema>;
export type ListMarketMcpRequest = z.infer<typeof listMarketMcpRequestSchema>;
export type ListMarketMcpResponse = z.infer<
  typeof listMarketMcpResponseSchema
>;
export type GetMarketMcpResponse = z.infer<typeof getMarketMcpResponseSchema>;
export type GetMarketMcpManifestResponse = z.infer<
  typeof getMarketMcpManifestResponseSchema
>;
export type MarketCategory = z.infer<typeof marketCategorySchema>;
export type ListMarketCategoriesResponse = z.infer<
  typeof listMarketCategoriesResponseSchema
>;
