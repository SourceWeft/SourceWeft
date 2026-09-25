import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityManifestSchema, type CapabilityManifest } from "./index";

export const CAPABILITY_MANIFEST_FILE_NAME = "sourceweft.capability.json";

export type CapabilityManifestFixture = {
  /** The file exactly as shipped, for comparison against a TypeScript export. */
  readonly raw: unknown;
  /** The same file after schema parsing, with contributions normalized. */
  readonly manifest: CapabilityManifest;
};

/**
 * Reads and parses the `sourceweft.capability.json` a package ships.
 *
 * `packageRoot` is the directory holding the manifest, either as a path or as
 * a `file:` URL (typically `new URL("../", import.meta.url)` from a test under
 * the package's `tests/` directory). Both the raw JSON and the parsed manifest
 * come back because they answer different questions: the raw file is what a
 * package's TypeScript export must match byte-for-byte, while the parsed
 * manifest is what the host actually reads.
 */
export async function loadCapabilityManifestFixture(
  packageRoot: string | URL,
): Promise<CapabilityManifestFixture> {
  const root =
    typeof packageRoot === "string" ? packageRoot : fileURLToPath(packageRoot);
  const raw: unknown = JSON.parse(
    await readFile(join(root, CAPABILITY_MANIFEST_FILE_NAME), "utf8"),
  );
  return { raw, manifest: capabilityManifestSchema.parse(raw) };
}
