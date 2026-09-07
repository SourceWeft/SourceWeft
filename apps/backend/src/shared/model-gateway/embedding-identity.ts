import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  chunkEmbeddings,
  db,
  modelGatewayProfiles,
  modelGatewayRoutes,
  type ModelGatewayProviderKind,
} from "@sourceweft/db";
import type { ProviderRoutingConfig } from "@sourceweft/model-gateway";
import type {
  GlobalGatewayEntry,
  GlobalModelProfileEntry,
} from "./global-config";
import { mapModelGatewayProfile } from "./profiles";
import {
  loadRoutedGatewayConfig,
  normalizeRouteProviderRouting,
  withOpenRouterAttributionHeaders,
} from "./runtime";
import type { RoutedGatewayConfig, RuntimeModelGatewayProfile } from "./types";

export const MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID = 7_344_001;
export type EmbeddingTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** No credentials or credential hashes. Revision also fences opaque header changes. */
export type EmbeddingIndexIdentity = {
  version: 1;
  revision: string;
  profileId: string;
  profileAlias: string;
  provider: string;
  providerKind: ModelGatewayProviderKind;
  baseUrl: string;
  providerModel: string;
  requestedDimensions: number | null;
  providerRouting: ProviderRoutingConfig | null;
};

export class EmbeddingIdentityError extends Error {
  readonly code = "EMBEDDING_IDENTITY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "EmbeddingIdentityError";
  }
}

/** Shared only for short database operations; never retain it during a model call. */
export async function lockEmbeddingConfiguration(tx: EmbeddingTransaction) {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(${MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID})`,
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function embeddingIdentitiesEqual(
  left: EmbeddingIndexIdentity,
  right: EmbeddingIndexIdentity,
) {
  return stableJson(left) === stableJson(right);
}

function sameDefinition(
  left: EmbeddingIndexIdentity,
  right: EmbeddingIndexIdentity,
) {
  const { revision: _leftRevision, ...leftDefinition } = left;
  const { revision: _rightRevision, ...rightDefinition } = right;
  return stableJson(leftDefinition) === stableJson(rightDefinition);
}

function normalizeBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.hash || url.search) {
    throw new EmbeddingIdentityError(
      "Embedding base URL must not contain credentials, query parameters, or a fragment",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function storedDefinition(profile: RuntimeModelGatewayProfile) {
  const value = profile.configJson.embeddingDefinition;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const definition = value as EmbeddingIndexIdentity;
  return definition.version === 1 && typeof definition.revision === "string"
    ? definition
    : null;
}

function definitionForRuntime(
  profile: RuntimeModelGatewayProfile,
  routedConfig: RoutedGatewayConfig,
  revision: string,
): EmbeddingIndexIdentity {
  const targets = routedConfig.modelRoutes[profile.profileAlias]?.targets;
  if (targets?.length !== 1 || !targets[0]) {
    throw new EmbeddingIdentityError(
      `Embedding profile '${profile.profileAlias}' requires exactly one configured target`,
    );
  }
  const target = targets[0];
  const provider = routedConfig.providers[target.provider];
  if (!provider) {
    throw new EmbeddingIdentityError(
      `Embedding profile '${profile.profileAlias}' has no configured Provider`,
    );
  }
  return {
    version: 1,
    revision,
    profileId: profile.id,
    profileAlias: profile.profileAlias,
    provider: target.provider,
    providerKind: provider.kind,
    baseUrl: normalizeBaseUrl(provider.baseUrl),
    providerModel: target.model,
    requestedDimensions: profile.requestedDimensions,
    providerRouting: target.providerRouting ?? null,
  };
}

async function readPreparedProfile(tx: EmbeddingTransaction) {
  const [row] = await tx
    .select()
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, "embedding"),
        eq(modelGatewayProfiles.isDefault, true),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);
  if (!row) {
    throw new EmbeddingIdentityError(
      "Default embedding profile is not configured",
    );
  }
  const profile = mapModelGatewayProfile(row);
  const definition = storedDefinition(profile);
  if (!definition) {
    throw new EmbeddingIdentityError(
      "Embedding configuration has no recorded definition; synchronize the model configuration before indexing or vector retrieval",
    );
  }
  const routedConfig = await loadRoutedGatewayConfig(tx);
  if (!routedConfig) {
    throw new EmbeddingIdentityError(
      "Embedding gateway configuration is not available",
    );
  }
  const identity = definitionForRuntime(
    profile,
    routedConfig,
    definition.revision,
  );
  if (!embeddingIdentitiesEqual(identity, definition)) {
    throw new EmbeddingIdentityError(
      "Embedding profile and gateway definitions do not match",
    );
  }
  return { profile, routedConfig, identity };
}

export async function prepareEmbeddingProfile() {
  return db.transaction(async (tx) => {
    await lockEmbeddingConfiguration(tx);
    return readPreparedProfile(tx);
  });
}

/** Call before any index mutation or vector-distance query in the same transaction. */
export async function assertEmbeddingIdentityCurrent(
  tx: EmbeddingTransaction,
  identity: EmbeddingIndexIdentity,
) {
  await lockEmbeddingConfiguration(tx);
  const current = await readPreparedProfile(tx);
  if (!embeddingIdentitiesEqual(current.identity, identity)) {
    throw new EmbeddingIdentityError(
      "Embedding configuration changed while the operation was in flight; its result cannot be written or searched",
    );
  }
  return current;
}

export function validateEmbeddingResult(
  identity: EmbeddingIndexIdentity,
  result: { provider?: string; providerModel?: string },
  vectors: readonly (readonly number[])[],
) {
  if (
    result.provider !== identity.provider ||
    result.providerModel !== identity.providerModel
  ) {
    throw new EmbeddingIdentityError(
      "Embedding result used a different Provider or model",
    );
  }
  const dimensions = vectors[0]?.length;
  if (
    !dimensions ||
    dimensions > 2000 ||
    (identity.requestedDimensions !== null &&
      dimensions !== identity.requestedDimensions) ||
    vectors.some(
      (vector) =>
        vector.length !== dimensions ||
        vector.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new EmbeddingIdentityError(
      "Embedding result dimensions do not match the index definition",
    );
  }
  return dimensions;
}

type CandidateProfile = GlobalModelProfileEntry & {
  requestedDimensions?: number | null;
  vectorStrategy?: "auto" | "exact" | "disabled";
};

/**
 * Invoked with the config sync's exclusive lock, before its first mutation.
 * The returned definition describes configuration only. It does not establish
 * provenance for historical vectors; only a document written by the guarded
 * index writer receives documentMetadata.embeddingIdentity.
 */
export async function prepareEmbeddingDefinitionsForSync(
  tx: EmbeddingTransaction,
  input: { profiles: CandidateProfile[]; gateways: GlobalGatewayEntry[] },
) {
  const rows = await tx
    .select()
    .from(modelGatewayProfiles)
    .where(eq(modelGatewayProfiles.kind, "embedding"));
  const existingProfiles = rows.map(mapModelGatewayProfile);
  const indexedRows = await tx
    .selectDistinct({ profileId: chunkEmbeddings.embeddingProfileId })
    .from(chunkEmbeddings);
  const indexedIds = new Set(indexedRows.map((row) => row.profileId));
  const routedConfig = await loadRoutedGatewayConfig(tx);
  if (routedConfig) {
    // Synchronization compares inactive definitions too. Runtime deliberately
    // excludes those routes, so read their persisted definition in this same
    // transaction rather than generating a new revision on every no-op sync.
    const routes = await tx
      .select()
      .from(modelGatewayRoutes)
      .where(
        and(
          eq(modelGatewayRoutes.configVersionId, routedConfig.versionId),
          eq(modelGatewayRoutes.routeKind, "embedding"),
        ),
      );
    const grouped = new Map<
      string,
      RoutedGatewayConfig["modelRoutes"][string]
    >();
    for (const route of routes) {
      const entry = grouped.get(route.alias) ?? {
        strategy: route.strategy,
        targets: [],
      };
      entry.targets.push({
        provider: route.targetProviderName,
        model: route.targetModel,
        providerRouting: normalizeRouteProviderRouting(route.constraintsJson),
      });
      grouped.set(route.alias, entry);
    }
    Object.assign(routedConfig.modelRoutes, Object.fromEntries(grouped));
  }
  const candidates = new Map<
    string,
    {
      identity: EmbeddingIndexIdentity;
      entry: CandidateProfile;
      unchanged: boolean;
    }
  >();

  for (const entry of input.profiles) {
    const existing = existingProfiles.find((profile) =>
      entry.profileId
        ? profile.id === entry.profileId
        : profile.profileAlias === entry.profileAlias,
    );
    const [target] = entry.targets;
    if (entry.targets.length !== 1 || !target) {
      throw new EmbeddingIdentityError(
        `Embedding profile '${entry.profileAlias}' requires exactly one target`,
      );
    }
    const gateway = input.gateways.find(
      (candidate) =>
        candidate.slug === target.gatewaySlug &&
        candidate.providerName === target.providerName,
    );
    if (!gateway) {
      throw new EmbeddingIdentityError(
        `Embedding profile '${entry.profileAlias}' has no configured Provider`,
      );
    }
    const previous = existing ? storedDefinition(existing) : null;
    const revision = previous?.revision ?? randomUUID();
    const identity: EmbeddingIndexIdentity = {
      version: 1,
      revision,
      profileId: existing?.id ?? entry.profileId ?? randomUUID(),
      profileAlias: entry.profileAlias,
      provider: target.providerName,
      providerKind: gateway.providerKind,
      baseUrl: normalizeBaseUrl(gateway.baseUrl),
      providerModel: target.targetModel,
      requestedDimensions: entry.requestedDimensions ?? null,
      providerRouting: target.providerRouting ?? entry.providerRouting ?? null,
    };
    let unchanged = false;
    if (
      existing &&
      routedConfig?.modelRoutes[existing.profileAlias]?.targets.length === 1
    ) {
      const oldDefinition = definitionForRuntime(
        existing,
        routedConfig,
        revision,
      );
      const oldHeaders =
        routedConfig.providers[oldDefinition.provider]?.defaultHeaders;
      const newHeaders = withOpenRouterAttributionHeaders({
        providerKind: gateway.providerKind,
        defaultHeaders: gateway.defaultHeaders,
      });
      unchanged =
        sameDefinition(oldDefinition, identity) &&
        stableJson(oldHeaders) === stableJson(newHeaders) &&
        (existing.vectorStrategy === "disabled") ===
          (entry.vectorStrategy === "disabled") &&
        (!previous || embeddingIdentitiesEqual(previous, oldDefinition));
    }
    if (!unchanged) {
      identity.revision = randomUUID();
    }
    if (candidates.has(identity.profileId)) {
      throw new EmbeddingIdentityError(
        "Multiple embedding profiles refer to the same profile ID",
      );
    }
    candidates.set(identity.profileId, { identity, entry, unchanged });
  }

  for (const profile of existingProfiles) {
    if (!indexedIds.has(profile.id)) continue;
    const candidate = candidates.get(profile.id);
    if (
      !candidate ||
      !candidate.unchanged ||
      (profile.isActive && !candidate.entry.isActive) ||
      (profile.vectorStrategy !== "disabled" &&
        candidate.entry.vectorStrategy === "disabled")
    ) {
      throw new EmbeddingIdentityError(
        `Embedding profile '${profile.profileAlias}' has indexed vectors; changing its model, endpoint, dimensions, semantic configuration, or availability requires an explicit rebuild`,
      );
    }
  }

  if (indexedIds.size > 0) {
    const oldDefault = existingProfiles.find(
      (profile) => profile.isDefault && profile.isActive,
    );
    const newDefault = [...candidates.values()].find(
      (candidate) => candidate.entry.isDefault && candidate.entry.isActive,
    );
    if (!oldDefault || oldDefault.id !== newDefault?.identity.profileId) {
      throw new EmbeddingIdentityError(
        "Indexed vectors exist; changing the default embedding profile requires an explicit rebuild",
      );
    }
  }

  return new Map(
    [...candidates.values()].map(({ identity }) => [
      identity.profileAlias,
      identity,
    ]),
  );
}
