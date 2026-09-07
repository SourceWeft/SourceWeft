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
    index.byBareName.set(
      bare,
      mergeModelInfo(index.byBareName.get(bare), info),
    );
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
 * (lowest → highest): LiteLLM < models.dev < overrides. Both remote sources
 * are required when this registry is loaded; failure never changes that policy.
 */
export class ModelCatalogRegistry {
  // Global (provider-agnostic) union — every source, every provider merged.
  private global: ModelIndex = emptyIndex();
  // Per-provider unions, so a model's price is read from its serving provider's
  // bucket instead of an arbitrary same-id entry from another provider.
  private byProvider = new Map<string, ModelIndex>();
  // LiteLLM-only — the community's curated one-price-per-model book. Used as the
  // official reference price when no serving provider is known (no hint, no id
  // prefix), instead of an arbitrary reseller price from the global union.
  private litellm: ModelIndex = emptyIndex();
  private overrides = new Map<string, ModelInfoOverride>();
  private ready = false;
  private inflight: Promise<void> | null = null;
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sources: ModelCatalogSources = DEFAULT_SOURCES,
  ) {}

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
      // A timer must not introduce network dependencies before a caller needs
      // this registry (e.g. a private deployment with static, disabled catalogs).
      if (!this.ready) return;
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
    const litellmIndex = emptyIndex();
    const byProvider = new Map<string, ModelIndex>();
    for (const info of litellm) {
      indexEntry(litellmIndex, info);
    }
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
    // Overrides can fail too. Build every component before publishing any part.
    const overrides = this.sources.overrides();
    this.global = global;
    this.litellm = litellmIndex;
    this.byProvider = byProvider;
    this.overrides = overrides;
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
    // The same model reaches `byId` under different id forms across sources
    // (models.dev `deepseek-v4-pro` vs LiteLLM `deepseek/deepseek-v4-pro`;
    // models.dev `openai/gpt-image-1` vs LiteLLM `gpt-image-1` + its
    // `{quality}/{WxH}` tiers), so they only reconcile in the bare-name union.
    // That union already merges every id form with source precedence (models.dev
    // over LiteLLM), and is a superset of the exact-id entry — so it wins.
    // Merging the exact entry underneath only backfills a field the union lacks;
    // it must not let an exact match on a lower-precedence source's id form
    // override the primary source's price.
    return mergeModelInfo(exact, byBare);
  }

  private lookupBase(
    modelId: string,
    provider?: string,
  ): NormalizedModelInfo | null {
    const globalBase = this.lookupInIndex(this.global, modelId);
    // Two explicit serving-provider signals, most authoritative first: the
    // caller's hint (its gateway route), then the id's own `vendor/` prefix
    // (models.dev's reseller ids name the origin vendor). The first provider
    // bucket that matches supplies the price; a shared model id is thus never
    // priced from an arbitrary other provider's entry.
    const providerKeys: string[] = [];
    for (const key of [
      canonicalProviderKey(provider),
      providerFromId(modelId),
    ]) {
      if (key && !providerKeys.includes(key)) {
        providerKeys.push(key);
      }
    }
    for (const key of providerKeys) {
      const bucket = this.byProvider.get(key);
      const providerBase = bucket ? this.lookupInIndex(bucket, modelId) : null;
      if (providerBase) {
        // Global as capability gap-filler underneath the provider-authoritative
        // entry (provider wins every scalar field, including price).
        return globalBase
          ? mergeModelInfo(globalBase, providerBase)
          : providerBase;
      }
    }
    // No provider known — fall back to LiteLLM's official one-price-per-model
    // reference for the price (capabilities still enriched from the union),
    // rather than the union's arbitrary reseller price. LiteLLM silent → union.
    const litellmBase = this.lookupInIndex(this.litellm, modelId);
    if (litellmBase) {
      return globalBase ? mergeModelInfo(globalBase, litellmBase) : litellmBase;
    }
    return globalBase;
  }

  /**
   * Resolve a model id to its normalized capabilities. Synchronous, in-memory:
   * exact id → bare name → snapshot-stripped bare name, then a hand-authored
   * override applied on top. Pricing follows the serving provider: pass
   * `opts.provider` (the gateway route's provider) and/or rely on the id's
   * `vendor/` prefix; the first matching provider bucket wins. With no provider
   * signal at all, price falls back to LiteLLM's official one-price-per-model
   * reference, then the global union. An override with no discovered base (e.g.
   * an aggregator routing slug) still resolves. Returns null when nothing
   * matches, so callers can default-allow rather than block an unknown model.
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
