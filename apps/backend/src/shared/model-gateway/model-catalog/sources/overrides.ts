import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveBackendRuntimePath } from "../../../runtime-paths";
import { canonicalModelId, type ModelInfoOverride } from "../types";

export type ModelOverrideMap = Record<string, ModelInfoOverride>;

function parseOverrideFile(filePath: string): ModelOverrideMap {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.entries(parsed).every(
        ([key, value]) =>
          key.trim() &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value),
      )
    ) {
      return parsed as ModelOverrideMap;
    }
  } catch {
    // Do not include JSON parser excerpts: an operator may paste a credential.
    throw new Error(`Unable to read a valid model overrides file: ${filePath}`);
  }
  throw new Error(
    `Model overrides must be an object of model entries: ${filePath}`,
  );
}

// In-repo overrides (apps/backend/config/model-overrides.json). Optional.
function loadRepoOverrides(): ModelOverrideMap {
  let filePath: string;
  try {
    filePath = resolveBackendRuntimePath({
      candidates: ["config/model-overrides.json"],
      label: "model overrides",
    });
  } catch {
    // The repository file is optional. Once found, malformed contents fail.
    return {};
  }
  return parseOverrideFile(filePath);
}

// Optional external overrides layered on top (e.g. private SaaS additions).
function loadEnvOverrides(): ModelOverrideMap {
  const configured = process.env.MODEL_OVERRIDES_PATH?.trim();
  if (!configured) return {};
  const resolved = path.resolve(configured);
  if (!existsSync(resolved)) {
    throw new Error("Configured MODEL_OVERRIDES_PATH does not exist");
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
