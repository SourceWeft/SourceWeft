import { logger } from "../../logger";
import { loadLiteLLMModels } from "./sources/litellm";
import { loadModelsDevModels } from "./sources/models-dev";
import { loadModelOverrides } from "./sources/overrides";
import {
  applyOverride,
  bareModelName,
  canonicalModelId,
  emptyModelInfo,
  mergeModelInfo,
  stripSnapshotSuffix,
  type ModelInfoOverride,
  type NormalizedModelInfo,
} from "./types";

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
  private byId = new Map<string, NormalizedModelInfo>();
  private byBareName = new Map<string, NormalizedModelInfo>();
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
    const byId = new Map<string, NormalizedModelInfo>();
    const byBareName = new Map<string, NormalizedModelInfo>();
    for (const info of [...litellm, ...modelsDev]) {
      const cid = canonicalModelId(info.id);
      byId.set(cid, mergeModelInfo(byId.get(cid), info));
      const bare = bareModelName(info.id);
      if (bare) {
        byBareName.set(bare, mergeModelInfo(byBareName.get(bare), info));
      }
    }
    this.byId = byId;
    this.byBareName = byBareName;
    this.overrides = this.sources.overrides();
    this.ready = true;
    logger.info("Model catalog registry refreshed", {
      models: byId.size,
      litellm: litellm.length,
      modelsDev: modelsDev.length,
      overrides: this.overrides.size,
    });
  }

  private lookupBase(modelId: string): NormalizedModelInfo | null {
    const bare = bareModelName(modelId);
    return (
      this.byId.get(canonicalModelId(modelId)) ??
      this.byBareName.get(bare) ??
      this.byBareName.get(stripSnapshotSuffix(bare)) ??
      null
    );
  }

  /**
   * Resolve a model id to its normalized capabilities. Synchronous, in-memory:
   * exact id → bare name → snapshot-stripped bare name, then a hand-authored
   * override applied on top. An override with no discovered base (e.g. an
   * aggregator routing slug) still resolves. Returns null when nothing matches,
   * so callers can default-allow rather than block an unknown model.
   */
  resolve(modelId: string): NormalizedModelInfo | null {
    const base = this.lookupBase(modelId);
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
