import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./shared";
import { workspaces } from "./identity-workspace";

type ModelGatewayProfileKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";
type EmbeddingVectorStrategy = "auto" | "exact" | "disabled";
export type ModelGatewayProviderKind =
  | "openai-compatible"
  | "cloudflare-aig"
  | "openrouter"
  | "deepinfra"
  | "deepseek"
  | "siliconflow-cn"
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure-openai";
type ModelGatewayRouteKind =
  | "chat"
  | "rerank"
  | "embedding"
  | "asr"
  | "tts"
  | "vision"
  | "image"
  | "video";
export type ModelGatewayRoutingStrategy = "priority" | "weighted-random";

export const modelGatewayConfigs = pgTable(
  "model_gateway_configs",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEncrypted: text("api_key_encrypted"),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    maxRetries: integer("max_retries").notNull().default(2),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    isBYOK: boolean("is_byok").notNull().default(false),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_configs_slug_uq").on(table.slug),
    uniqueIndex("model_gateway_configs_default_uq")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
    check(
      "model_gateway_configs_timeout_ms_check",
      sql`${table.timeoutMs} > 0`,
    ),
    check(
      "model_gateway_configs_max_retries_check",
      sql`${table.maxRetries} >= 0`,
    ),
    index("model_gateway_configs_default_active_idx").on(
      table.isDefault,
      table.isActive,
    ),
  ],
);

export const modelGatewayConfigVersions = pgTable(
  "model_gateway_config_versions",
  {
    id: text("id").primaryKey(),
    versionHash: text("version_hash").notNull(),
    sourcePath: text("source_path"),
    isActive: boolean("is_active").notNull().default(false),
    payloadJson: jsonb("payload_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_config_versions_hash_uq").on(table.versionHash),
    uniqueIndex("model_gateway_config_versions_active_uq")
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
    index("model_gateway_config_versions_created_idx").on(
      desc(table.createdAt),
    ),
  ],
);

export const modelGatewayProviderConfigs = pgTable(
  "model_gateway_provider_configs",
  {
    id: text("id").primaryKey(),
    configVersionId: text("config_version_id")
      .notNull()
      .references(() => modelGatewayConfigVersions.id, { onDelete: "cascade" }),
    providerName: text("provider_name").notNull(),
    providerKind: text("provider_kind")
      .$type<ModelGatewayProviderKind>()
      .notNull(),
    gatewayConfigId: text("gateway_config_id").references(
      () => modelGatewayConfigs.id,
      { onDelete: "set null" },
    ),
    baseUrl: text("base_url").notNull(),
    apiKeySource: text("api_key_source"),
    isActive: boolean("is_active").notNull().default(true),
    capabilitiesJson: jsonb("capabilities_json")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_provider_configs_version_name_uq").on(
      table.configVersionId,
      table.providerName,
    ),
    check(
      "model_gateway_provider_configs_kind_check",
      sql`${table.providerKind} in ('openai-compatible', 'cloudflare-aig', 'openrouter', 'deepinfra', 'deepseek', 'siliconflow-cn', 'openai', 'anthropic', 'gemini', 'azure-openai')`,
    ),
    index("model_gateway_provider_configs_active_idx").on(
      table.configVersionId,
      table.isActive,
    ),
  ],
);

export const modelGatewayByokCredentials = pgTable(
  "model_gateway_byok_credentials",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    providerName: text("provider_name").notNull(),
    providerKind: text("provider_kind")
      .$type<ModelGatewayProviderKind>()
      .notNull()
      .default("openai-compatible"),
    baseUrl: text("base_url"),
    credentialAlias: text("credential_alias").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    defaultHeadersJson: jsonb("default_headers_json")
      .$type<Record<string, string>>()
      .notNull()
      .default(emptyJsonObject),
    isActive: boolean("is_active").notNull().default(true),
    metadataJson: jsonb("metadata_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "model_gateway_byok_credentials_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("model_gateway_byok_credentials_lookup_idx").on(
      table.teamId,
      table.workspaceId,
      table.userId,
      table.providerName,
      table.isActive,
    ),
    uniqueIndex("model_gateway_byok_credentials_alias_uq").on(
      table.workspaceId,
      table.userId,
      table.providerName,
      table.credentialAlias,
    ),
    check(
      "model_gateway_byok_credentials_kind_check",
      sql`${table.providerKind} in ('openai-compatible', 'cloudflare-aig', 'openrouter', 'deepinfra', 'deepseek', 'siliconflow-cn', 'openai', 'anthropic', 'gemini', 'azure-openai')`,
    ),
  ],
);

export const modelGatewayByokModels = pgTable(
  "model_gateway_byok_models",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => modelGatewayByokCredentials.id, {
        onDelete: "restrict",
      }),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    providerName: text("provider_name").notNull(),
    modelName: text("model_name").notNull(),
    displayName: text("display_name").notNull(),
    modelType: text("model_type").$type<"llm" | "image" | "vision">().notNull(),
    capabilitiesJson: jsonb("capabilities_json").$type<Record<
      string,
      unknown
    > | null>(),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "model_gateway_byok_models_workspace_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
    }).onDelete("cascade"),
    index("model_gateway_byok_models_credential_idx").on(
      table.credentialId,
      table.isActive,
    ),
    index("model_gateway_byok_models_lookup_idx").on(
      table.teamId,
      table.workspaceId,
      table.userId,
      table.providerName,
      table.modelType,
      table.isActive,
    ),
    uniqueIndex("model_gateway_byok_models_credential_model_uq").on(
      table.workspaceId,
      table.userId,
      table.credentialId,
      table.modelName,
      table.modelType,
    ),
    check(
      "model_gateway_byok_models_type_check",
      sql`${table.modelType} in ('llm', 'image', 'vision')`,
    ),
  ],
);

export const modelGatewayRoutes = pgTable(
  "model_gateway_routes",
  {
    id: text("id").primaryKey(),
    configVersionId: text("config_version_id")
      .notNull()
      .references(() => modelGatewayConfigVersions.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    routeKind: text("route_kind").$type<ModelGatewayRouteKind>().notNull(),
    strategy: text("strategy")
      .$type<ModelGatewayRoutingStrategy>()
      .notNull()
      .default("priority"),
    targetProviderName: text("target_provider_name").notNull(),
    targetModel: text("target_model").notNull(),
    priority: integer("priority").notNull().default(1),
    weight: integer("weight").notNull().default(0),
    constraintsJson: jsonb("constraints_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "model_gateway_routes_kind_check",
      sql`${table.routeKind} in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video')`,
    ),
    check(
      "model_gateway_routes_strategy_check",
      sql`${table.strategy} in ('priority', 'weighted-random')`,
    ),
    check("model_gateway_routes_priority_check", sql`${table.priority} > 0`),
    check("model_gateway_routes_weight_check", sql`${table.weight} >= 0`),
    index("model_gateway_routes_lookup_idx").on(
      table.configVersionId,
      table.alias,
      table.routeKind,
      table.isActive,
    ),
  ],
);

export const modelGatewayProfiles = pgTable(
  "model_gateway_profiles",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ModelGatewayProfileKind>().notNull(),
    gatewayConfigId: text("gateway_config_id")
      .notNull()
      .references(() => modelGatewayConfigs.id, { onDelete: "cascade" }),
    profileAlias: text("profile_alias").notNull(),
    modelAlias: text("model_alias").notNull(),
    requestedDimensions: integer("requested_dimensions"),
    vectorStrategy: text("vector_strategy")
      .$type<EmbeddingVectorStrategy>()
      .notNull()
      .default("auto"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    configJson: jsonb("config_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_gateway_profiles_alias_uq").on(table.profileAlias),
    uniqueIndex("model_gateway_profiles_default_kind_uq")
      .on(table.kind)
      .where(sql`${table.isDefault} = true`),
    check(
      "model_gateway_profiles_kind_check",
      sql`${table.kind} in ('chat', 'rerank', 'embedding', 'asr', 'tts', 'vision', 'image', 'video')`,
    ),
    check(
      "model_gateway_profiles_vector_strategy_check",
      sql`${table.vectorStrategy} in ('auto', 'exact', 'disabled')`,
    ),
    check(
      "model_gateway_profiles_requested_dimensions_check",
      sql`${table.requestedDimensions} is null or (${table.requestedDimensions} > 0 and ${table.requestedDimensions} <= 2000)`,
    ),
    index("model_gateway_profiles_kind_default_active_idx").on(
      table.kind,
      table.isDefault,
      table.isActive,
    ),
  ],
);
