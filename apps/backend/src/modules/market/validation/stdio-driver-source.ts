import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveBackendRuntimePath } from "../../../shared/runtime-paths";

/**
 * Where `stdio-driver.mjs` lives in this checkout or build. The build copies
 * it next to the mail templates (`scripts/copy-runtime-assets.mjs`); in
 * development it is read from the source tree.
 */
export const MCP_STDIO_DRIVER_FILE = "stdio-driver.mjs";

let cached: string | null = null;

/** The driver's source, read once; the sandbox gets a copy of these bytes. */
export function stdioDriverSource(): string {
  if (cached === null) {
    const directory = resolveBackendRuntimePath({
      candidates: [
        "dist/modules/market/validation",
        "src/modules/market/validation",
      ],
      label: "MCP stdio validation driver directory",
    });
    cached = readFileSync(path.join(directory, MCP_STDIO_DRIVER_FILE), "utf8");
  }
  return cached;
}
