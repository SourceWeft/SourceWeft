import { CHROME_HEADLESS_SHELL_ASSET } from "@sourceweft/builtin-tool-video-presentation";

/**
 * The platform's runtime-asset catalog
 * (docs/architecture/sandbox-runtime-assets.md, A3): every asset a sandbox
 * may require, aggregated from the features that own them. A feature declares
 * its asset beside the dependency pin that makes the version correct
 * (chrome-headless-shell lives next to the @remotion/renderer pin in the
 * video package); this file only assembles the lookup table.
 */
export type SandboxAssetSpec = {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly sha256: string;
  readonly archive: "zip";
  readonly entrypoint: string;
  readonly sizeBytes?: number;
  readonly upstreamUrls: readonly string[];
};

const CATALOG: readonly SandboxAssetSpec[] = [CHROME_HEADLESS_SHELL_ASSET];

export function findSandboxAssetSpec(
  name: string,
): SandboxAssetSpec | undefined {
  return CATALOG.find((spec) => spec.name === name);
}
