import { logger } from "../../logger";
import { loadLiteLLMModels } from "./sources/litellm";
import { loadModelsDevModels } from "./sources/models-dev";
import { loadModelOverrides } from "./sources/overrides";
import {
  applyOverride,
  bareModelName,
  canonicalModelId,
  canonicalProviderKey,
  emptyModelInfo,
  mergeModelInfo,
  providerFromId,
  stripSnapshotSuffix,
  type ModelInfoOverride,
  type NormalizedModelInfo,
} from "./types";

/** Two indexes over one set of merged entries: by full id and by bare name. */
interface ModelIndex {
  byId: Map<string, NormalizedModelInfo>;
  byBareName: Map<string, NormalizedModelInfo>;
}

function emptyIndex(): ModelIndex {
  return { byId: new Map(), byBareName: new Map() };
}

/** Merge one entry into an index under both its full id and bare name. */
function indexEntry(index: ModelIndex, info: NormalizedModelInfo): void {
  const cid = canonicalModelId(info.id);
  index.byId.set(cid, mergeModelInfo(index.byId.get(cid), info));
  const bare = bareModelName(info.id);
  if (bare) {
    index.byBareName.set(bare, mergeModelInfo(index.byBareName.get(bare), info));
  }
}

/** Data sources, injectable so tests can seed the registry without network. */
export interface ModelCatalogSources {
  litellm: () => Promise<NormalizedModelInfo[]>;
  modelsDev: () => Promise<NormalizedModelInfo[]>;
  overrides: () => Map<string, ModelInfoOverride>;
}

const DEFAULT_SOURCES: ModelCatalogSources = {
  litellm: loadLiteLLMModels,
  modelsDev: loadModelsDevModels,
  overrides: loadModelOverrides,
};

/**
 * In-memory catalog of normalized model capabilities, assembled from multiple
 * sources at preheat time and queried synchronously on the hot path.
 *
 * Preload, never fetch on resolve: call {@link refresh} at startup / active
 * sync; {@link resolve} only reads the in-memory indexes. Merge precedence
 * (lowest → highest): LiteLLM (fallback) < models.dev (primary) < overrides.
 */
export class ModelCatalogRegistry {
  // Global (provider-agnostic) union — every source, every provider merged.
  private global: ModelIndex = emptyIndex();
  // Per-provider unions, so a model's price is read from its serving provider's
  // bucket instead of an arbitrary same-id entry from another provider.
  private byProvider = new Map<string, ModelIndex>();
  private overrides = new Map<string, ModelInfoOverride>();
  private ready = false;
  private inflight: Promise<void> | null = null;
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sources: ModelCatalogSources = DEFAULT_SOURCES) {}

  isReady() {
    return this.ready;
  }

  /**
   * Periodically refresh in-process so a long-running server picks up upstream
   * capability/pricing updates without a restart. Idempotent; `intervalMs <= 0`
   * disables. The timer is unref'd so it never keeps the process alive.
   */
  startAutoRefresh(intervalMs: number): void {
    if (this.autoRefreshTimer || intervalMs <= 0) {
      return;
    }
    this.autoRefreshTimer = setInterval(() => {
      void this.refresh().catch((error) => {
        logger.warn("Model catalog periodic refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    this.autoRefreshTimer.unref?.();
  }

  /** Fetch all sources, normalize, merge, and rebuild indexes. Coalesced. */
  async refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Refresh once if never loaded; a no-op after the first successful load. */
  async ensureReady(): Promise<void> {
    if (!this.ready) {
      await this.refresh();
    }
  }

  private async doRefresh(): Promise<void> {
    // LiteLLM first (lowest precedence), models.dev second (primary, wins).
    const [litellm, modelsDev] = await Promise.all([
      this.sources.litellm(),
      this.sources.modelsDev(),
    ]);
    const global = emptyIndex();
    const byProvider = new Map<string, ModelIndex>();
    for (const info of [...litellm, ...modelsDev]) {
      indexEntry(global, info);
      const provider = canonicalProviderKey(info.provider);
      if (provider) {
        let bucket = byProvider.get(provider);
        if (!bucket) {
          bucket = emptyIndex();
          byProvider.set(provider, bucket);
        }
        indexEntry(bucket, info);
      }
    }
    this.global = global;
    this.byProvider = byProvider;
    this.overrides = this.sources.overrides();
    this.ready = true;
    logger.info("Model catalog registry refreshed", {
      models: global.byId.size,
      providers: byProvider.size,
      litellm: litellm.length,
      modelsDev: modelsDev.length,
      overrides: this.overrides.size,
    });
  }

  /** Best match within one index: exact id → bare → snapshot-stripped bare. */
  private lookupInIndex(
    index: ModelIndex,
    modelId: string,
  ): NormalizedModelInfo | null {
    const bare = bareModelName(modelId);
    const exact = index.byId.get(canonicalModelId(modelId)) ?? null;
    const byBare =
      index.byBareName.get(bare) ??
      index.byBareName.get(stripSnapshotSuffix(bare)) ??
      null;
    if (!exact) {
      return byBare;
    }
    if (!byBare || byBare === exact) {
      return exact;
    }
    // A provider-prefixed id (models.dev `openai/gpt-image-1`) and the bare id
    // its sibling sources use (LiteLLM `gpt-image-1`, `azure/gpt-image-1`, its
    // `{quality}/{WxH}` tiers) never share a `byId` key, so they only meet in
    // the bare-name union. Merge that union underneath the exact entry: the
    // provider-specific entry still wins per scalar field, while gaps it lacks
    // (image-token price, per-image tiers) are filled from the union.
    return mergeModelInfo(byBare, exact);
  }

  private lookupBase(
    modelId: string,
    provider?: string,
  ): NormalizedModelInfo | null {
    const globalBase = this.lookupInIndex(this.global, modelId);
    // Provider comes from the caller's serving-provider hint, else the id's own
    // prefix. Its bucket's data (crucially, its price) wins over the global
    // union, which mixes every provider's price for a shared model id.
    const providerKey =
      canonicalProviderKey(provider) ?? providerFromId(modelId);
    const bucket = providerKey ? this.byProvider.get(providerKey) : undefined;
    const providerBase = bucket ? this.lookupInIndex(bucket, modelId) : null;
    if (!providerBase) {
      return globalBase;
    }
    // Global as capability gap-filler underneath the provider-authoritative
    // entry (provider wins every scalar field, including price).
    return globalBase ? mergeModelInfo(globalBase, providerBase) : providerBase;
  }

  /**
   * Resolve a model id to its normalized capabilities. Synchronous, in-memory:
   * exact id → bare name → snapshot-stripped bare name, then a hand-authored
   * override applied on top. Pass `opts.provider` (the serving gateway's
   * provider) so pricing is read from that provider's bucket rather than an
   * arbitrary same-id entry; absent a hint the id prefix is used, else the
   * global union. An override with no discovered base (e.g. an aggregator
   * routing slug) still resolves. Returns null when nothing matches, so callers
   * can default-allow rather than block an unknown model.
   */
  resolve(
    modelId: string,
    opts?: { provider?: string },
  ): NormalizedModelInfo | null {
    const base = this.lookupBase(modelId, opts?.provider);
    const override =
      this.overrides.get(canonicalModelId(modelId)) ??
      this.overrides.get(bareModelName(modelId)) ??
      undefined;
    if (!base && !override) {
      return null;
    }
    return applyOverride(base ?? emptyModelInfo(modelId), override);
  }
}

export const modelCatalog = new ModelCatalogRegistry();
