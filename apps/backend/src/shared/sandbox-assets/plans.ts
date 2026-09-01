import type { RuntimeAssetPlan } from "@sourceweft/builtin-tool-sandbox";
import { loadSandboxAssetContent, presignSandboxAssetUrl } from "./cache";
import { findSandboxAssetSpec } from "./catalog";

/**
 * Resolve capability-declared runtime asset names through the host-owned
 * catalog. A missing catalog entry is a configuration error, never a silent
 * downgrade to a provider download or a different binary.
 */
export function buildRequiredSandboxRuntimeAssetPlans(
  names: readonly string[],
): RuntimeAssetPlan[] {
  return [...new Set(names)].sort().map((name) => {
    const spec = findSandboxAssetSpec(name);
    if (!spec) {
      throw new Error(
        `SANDBOX_RUNTIME_ASSET_NOT_REGISTERED: '${name}' is not in the host catalog.`,
      );
    }
    return {
      name: spec.name,
      version: spec.version,
      platform: spec.platform,
      sha256: spec.sha256,
      archive: spec.archive,
      entrypoint: spec.entrypoint,
      ...(spec.imagePathEnvVar
        ? { imagePathEnvVar: spec.imagePathEnvVar }
        : {}),
      fetchUrl: () => presignSandboxAssetUrl(spec),
      loadContent: () => loadSandboxAssetContent(spec),
    };
  });
}
