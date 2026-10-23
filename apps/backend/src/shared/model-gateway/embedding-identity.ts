import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  chunkEmbeddings,
  db,
  modelGatewayProfiles,
  modelGatewayRoutes,
  type ModelGatewayProviderKind,
} from "@sourceweft/db";
import {
  canonicalProviderModel,
  type ProviderRoutingConfig,
} from "@sourceweft/model-gateway";
import type {
  GlobalGatewayEntry,
  GlobalModelProfileEntry,
} from "./global-config";
import { mapModelGatewayProfile } from "./profiles";
import {
  loadRoutedGatewayConfig,
  normalizeRouteProviderRouting,
} from "./runtime";
import type { RoutedGatewayConfig, RuntimeModelGatewayProfile } from "./types";

export const MODEL_GATEWAY_CONFIG_SYNC_LOCK_ID = 7_344_001;
export type EmbeddingTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/**
 * What makes stored vectors comparable: the profile, the model and the
 * dimensions. Which Provider or endpoint produced a vector is deliberately not
 * part of it — the same model served by two Providers is one vector space, and
 * that is what lets an embedding alias fail over between Providers without a
 * second index or a rebuild. No credentials or credential hashes.
 */
export type EmbeddingIndexIdentity = {
  version: 2;
  revision: string;
  profileId: string;
  profileAlias: string;
  /** `canonicalProviderModel` of every target's model, e.g. `bge-m3`. */
  canonicalModel: string;
  requestedDimensions: number | null;
};

/**
 * The definition recorded before same-model fallback existed: it pinned one
 * Provider, endpoint and routing. Still read from profile rows and document
 * metadata so an upgrade neither re-embeds nor fences existing vectors; never
 * written again.
 */
export type LegacyEmbeddingIndexIdentity = {
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

/** Reads either recorded shape as the current one; the revision is kept. */
export function upgradeEmbeddingIdentity(
  stored: EmbeddingIndexIdentity | LegacyEmbeddingIndexIdentity,
): EmbeddingIndexIdentity {
  if (stored.version === 2) {
    return stored;
  }
  return {
    version: 2,
    revision: stored.revision,
    profileId: stored.profileId,
    profileAlias: stored.profileAlias,
    canonicalModel: canonicalProviderModel(stored.providerModel),
    requestedDimensions: stored.requestedDimensions ?? null,
  };
}

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

/**
 * SQL predicate: the identity recorded on a document (a jsonb expression, null
 * when the document predates recording) names a different index than the
 * current one. Compares the fields that define the identity rather than the
 * whole JSON, so a document stamped with the legacy single-target shape under
 * the same profile, revision, model and dimensions still reads as current.
 */
export function storedEmbeddingIdentityDiffers(
  stored: SQL,
  identity: EmbeddingIndexIdentity,
): SQL {
  return sql`(
    ${stored} is not null and (
      ${stored} ->> 'profileId' is distinct from ${identity.profileId}
      or ${stored} ->> 'revision' is distinct from ${identity.revision}
      or lower(btrim(regexp_replace(
        coalesce(${stored} ->> 'canonicalModel', ${stored} ->> 'providerModel', ''),
        '^.*/', ''
      ))) is distinct from ${identity.canonicalModel}
      or coalesce(${stored} -> 'requestedDimensions', 'null'::jsonb)
        is distinct from ${JSON.stringify(identity.requestedDimensions)}::jsonb
    )
  )`;
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

/**
 * The one model an embedding alias serves. Every target must resolve to the
 * same canonical model; the global config parser enforces this for file
 * profiles, and this check holds it for routes and dynamic profiles too.
 */
export function sharedCanonicalEmbeddingModel(
  profileAlias: string,
  models: readonly string[],
): string {
  const [first, ...rest] = models;
  if (first === undefined) {
    throw new EmbeddingIdentityError(
      `Embedding profile '${profileAlias}' requires at least one target`,
    );
  }
  const canonicalModel = canonicalProviderModel(first);
  const mixed = rest.find(
    (model) => canonicalProviderModel(model) !== canonicalModel,
  );
  if (mixed !== undefined) {
    throw new EmbeddingIdentityError(
      `Embedding profile '${profileAlias}' mixes models '${first}' and '${mixed}'; every target behind one alias must serve the same model`,
    );
  }
  return canonicalModel;
}

function storedDefinition(profile: RuntimeModelGatewayProfile) {
  const value = profile.configJson.embeddingDefinition;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const definition = value as
    EmbeddingIndexIdentity | LegacyEmbeddingIndexIdentity;
  return (definition.version === 1 || definition.version === 2) &&
    typeof definition.revision === "string"
    ? upgradeEmbeddingIdentity(definition)
    : null;
}

function definitionForRuntime(
  profile: RuntimeModelGatewayProfile,
  routedConfig: RoutedGatewayConfig,
  revision: string,
): EmbeddingIndexIdentity {
  const targets = routedConfig.modelRoutes[profile.profileAlias]?.targets ?? [];
  const canonicalModel = sharedCanonicalEmbeddingModel(
    profile.profileAlias,
    targets.map((target) => target.model),
  );
  for (const target of targets) {
    if (!routedConfig.providers[target.provider]) {
      throw new EmbeddingIdentityError(
        `Embedding profile '${profile.profileAlias}' has no configured Provider '${target.provider}'`,
      );
    }
  }
  return {
    version: 2,
    revision,
    profileId: profile.id,
    profileAlias: profile.profileAlias,
    canonicalModel,
    requestedDimensions: profile.requestedDimensions,
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

/**
 * A result may come from any of the alias's targets — that is what failover
 * is for — but it must be the alias's model.
 */
export function validateEmbeddingResult(
  identity: EmbeddingIndexIdentity,
  result: { providerModel?: string },
  vectors: readonly (readonly number[])[],
) {
  if (
    typeof result.providerModel !== "string" ||
    canonicalProviderModel(result.providerModel) !== identity.canonicalModel
  ) {
    throw new EmbeddingIdentityError("Embedding result used a different model");
  }
  return validateEmbeddingDimensions(identity, vectors);
}

export function validateEmbeddingDimensions(
  identity: EmbeddingIndexIdentity,
  vectors: readonly (readonly number[])[],
) {
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
    const canonicalModel = sharedCanonicalEmbeddingModel(
      entry.profileAlias,
      entry.targets.map((target) => target.targetModel),
    );
    for (const target of entry.targets) {
      const gateway = input.gateways.find(
        (candidate) =>
          candidate.slug === target.gatewaySlug &&
          candidate.providerName === target.providerName,
      );
      if (!gateway) {
        throw new EmbeddingIdentityError(
          `Embedding profile '${entry.profileAlias}' has no configured Provider for target '${target.gatewaySlug}/${target.targetModel}'`,
        );
      }
    }
    const previous = existing ? storedDefinition(existing) : null;
    const revision = previous?.revision ?? randomUUID();
    const identity: EmbeddingIndexIdentity = {
      version: 2,
      revision,
      profileId: existing?.id ?? entry.profileId ?? randomUUID(),
      profileAlias: entry.profileAlias,
      canonicalModel,
      requestedDimensions: entry.requestedDimensions ?? null,
    };
    // Adding, removing or reordering same-model targets, moving a Provider to
    // another endpoint, or changing its headers keeps the definition: none of
    // those changes the vector space. Only the model or the dimensions do.
    let unchanged = false;
    if (existing) {
      // The recorded definition is the baseline. A profile synced before
      // definitions were recorded has only its routes, so derive it from them.
      const fromRoutes =
        routedConfig && routedConfig.modelRoutes[existing.profileAlias]
          ? definitionForRuntime(existing, routedConfig, revision)
          : null;
      const baseline = previous ?? fromRoutes;
      unchanged =
        baseline !== null &&
        sameDefinition(baseline, identity) &&
        (!previous || !fromRoutes || sameDefinition(previous, fromRoutes)) &&
        (existing.vectorStrategy === "disabled") ===
          (entry.vectorStrategy === "disabled");
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
