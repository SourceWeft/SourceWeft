import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../../../logger";
import { resolveBackendRuntimePath } from "../../../runtime-paths";
import { canonicalModelId, type ModelInfoOverride } from "../types";

export type ModelOverrideMap = Record<string, ModelInfoOverride>;

function parseOverrideFile(filePath: string): ModelOverrideMap {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ModelOverrideMap;
    }
    logger.warn("Model overrides file is not a JSON object; ignoring", {
      path: filePath,
    });
  } catch (error) {
    logger.warn("Failed to read model overrides file", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {};
}

// In-repo overrides (apps/backend/config/model-overrides.json). Optional.
function loadRepoOverrides(): ModelOverrideMap {
  try {
    return parseOverrideFile(
      resolveBackendRuntimePath({
        candidates: ["config/model-overrides.json"],
        label: "model overrides",
      }),
    );
  } catch {
    return {};
  }
}

// Optional external overrides layered on top (e.g. private SaaS additions).
function loadEnvOverrides(): ModelOverrideMap {
  const configured = process.env.MODEL_OVERRIDES_PATH?.trim();
  if (!configured) return {};
  const resolved = path.resolve(configured);
  if (!existsSync(resolved)) {
    logger.warn("MODEL_OVERRIDES_PATH does not exist; ignoring", {
      path: resolved,
    });
    return {};
  }
  return parseOverrideFile(resolved);
}

/**
 * Hand-authored overrides, keyed by canonical id: fill models neither source
 * has (aggregator routing slugs), correct wrong facts, and steer modality.
 * Precedence: in-repo, then env on top (per key).
 */
export function loadModelOverrides(): Map<string, ModelInfoOverride> {
  const merged = new Map<string, ModelInfoOverride>();
  for (const [key, value] of Object.entries(loadRepoOverrides())) {
    merged.set(canonicalModelId(key), value);
  }
  for (const [key, value] of Object.entries(loadEnvOverrides())) {
    const cid = canonicalModelId(key);
    merged.set(cid, { ...merged.get(cid), ...value });
  }
  return merged;
}
