import { loadBuiltinCapabilityModule } from "@sourceweft/agent-tool-registry/server";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../../shared/logger";

/**
 * Loads a capability's entry module, once per process.
 *
 * Deliberately untyped beyond `Record<string, unknown>`: several unrelated
 * hosts (the turn's tool binder, the connector registry, the web provider)
 * each probe the same module for a different factory, and each narrows to its
 * own contract from `@sourceweft/contracts`. A union type here would make this
 * file grow a member per extension point — the exact coupling the boundary
 * exists to prevent.
 *
 * Builtin packages resolve through the static literal-import map in
 * `@sourceweft/agent-tool-registry`; see that file for why a variable dynamic
 * import cannot be the only path.
 */
export type CapabilityEntryModule = Record<string, unknown>;

const entryModuleCache = new Map<
  string,
  Promise<CapabilityEntryModule | null>
>();

export function loadCapabilityEntryModule(
  record: DiscoveredCapabilityRecord,
): Promise<CapabilityEntryModule | null> {
  const cacheKey = record.packageName ?? record.manifestPath;
  const cached = entryModuleCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = importCapabilityEntryModule(record);
  // Never let a failure stick: a cached null (or rejection) would disable the
  // capability for the whole process lifetime on one transient error.
  promise
    .then((module) => {
      if (!module) {
        entryModuleCache.delete(cacheKey);
      }
    })
    .catch(() => {
      entryModuleCache.delete(cacheKey);
    });
  entryModuleCache.set(cacheKey, promise);
  return promise;
}

async function importCapabilityEntryModule(
  record: DiscoveredCapabilityRecord,
): Promise<CapabilityEntryModule | null> {
  const builtin = loadBuiltinCapabilityModule(record.packageName);
  if (builtin) {
    // Builtins ship with the backend: a load failure here is a deployment
    // fault, not a degraded optional capability. Fail loudly rather than
    // silently serving a turn with no tools bound.
    return (await builtin()) as CapabilityEntryModule;
  }

  try {
    if (record.packageName) {
      return (await import(record.packageName)) as CapabilityEntryModule;
    }
    if (record.manifest.entry) {
      const entryPath = resolve(record.rootDir, record.manifest.entry);
      return (await import(
        pathToFileURL(entryPath).href
      )) as CapabilityEntryModule;
    }
  } catch (error) {
    logger.warn("Failed to load capability entry module", {
      capabilityId: record.manifest.id,
      packageName: record.packageName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}
