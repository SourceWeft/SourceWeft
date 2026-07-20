import { loadBuiltinCapabilityModule } from "@sourceweft/agent-tool-registry";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../../../../shared/logger";
import type { CapabilityAgentToolModule } from "./types";

const entryModuleCache = new Map<
  string,
  Promise<CapabilityAgentToolModule | null>
>();

export function loadCapabilityAgentToolModule(
  record: DiscoveredCapabilityRecord,
) {
  const cacheKey = record.packageName ?? record.manifestPath;
  const cached = entryModuleCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = importCapabilityAgentToolModule(record);
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

async function importCapabilityAgentToolModule(
  record: DiscoveredCapabilityRecord,
): Promise<CapabilityAgentToolModule | null> {
  const builtin = loadBuiltinCapabilityModule(record.packageName);
  if (builtin) {
    // Builtins ship with the backend: a load failure here is a deployment
    // fault, not a degraded optional capability. Fail loudly rather than
    // silently serving a turn with no tools bound.
    return (await builtin()) as CapabilityAgentToolModule;
  }

  try {
    if (record.packageName) {
      return (await import(record.packageName)) as CapabilityAgentToolModule;
    }
    if (record.manifest.entry) {
      const entryPath = resolve(record.rootDir, record.manifest.entry);
      return (await import(
        pathToFileURL(entryPath).href
      )) as CapabilityAgentToolModule;
    }
  } catch (error) {
    logger.warn("Failed to load capability agent tool entry", {
      capabilityId: record.manifest.id,
      packageName: record.packageName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}
