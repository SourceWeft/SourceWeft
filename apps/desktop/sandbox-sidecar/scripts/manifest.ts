/**
 * Pure helpers for `build.ts`: the bundle `manifest.json` and the Rust target triple it names.
 * Kept free of Bun APIs so `tests/bundle-manifest.test.ts` can run them under tsx.
 *
 * The manifest wire shape is fixed by Plan 2 ("Wire contracts"): the Rust installer
 * (`bundle_install.rs`) and `scripts/ci/sandbox-bundle.mjs` read exactly this.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILENAME = "manifest.json";

export type Manifest = {
  schemaVersion: 1;
  protocolVersion: number;
  appVersion: string;
  target: string;
  srtVersion: string;
  files: Record<string, { sha256: string; size: number }>;
};

/** Build host (`process.platform`/`process.arch`) -> the Rust triple the bundle is compiled for. */
const HOST_TARGETS: Record<string, string> = {
  "linux/x64": "x86_64-unknown-linux-gnu",
  "linux/arm64": "aarch64-unknown-linux-gnu",
  "darwin/x64": "x86_64-apple-darwin",
  "darwin/arm64": "aarch64-apple-darwin",
};

/**
 * The bundle is compiled by Bun for the machine running the build, so the target must be that
 * machine's triple. `--target` is required except on Linux x64 (the only release leg); there is
 * no guessing for any other host, and a triple that is unknown or not this host is refused.
 */
export function resolveTarget(
  explicit: string | undefined,
  platform: string,
  arch: string,
): string {
  const host = HOST_TARGETS[`${platform}/${arch}`];
  if (explicit === undefined) {
    if (host === "x86_64-unknown-linux-gnu") return host;
    throw new Error(
      `--target <rust triple> is required on ${platform}/${arch} (it is optional only on linux/x64)`,
    );
  }
  if (!Object.values(HOST_TARGETS).includes(explicit)) {
    throw new Error(`--target ${explicit} is not a supported bundle target`);
  }
  if (explicit !== host) {
    throw new Error(
      `--target ${explicit} does not match the build host ${platform}/${arch}; the sidecar is compiled for the host only`,
    );
  }
  return explicit;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function buildManifest(input: {
  bundleDir: string;
  protocolVersion: number;
  appVersion: string;
  target: string;
  srtVersion: string;
}): Manifest {
  if (!Number.isInteger(input.protocolVersion) || input.protocolVersion < 1) {
    throw new Error(`invalid protocolVersion ${String(input.protocolVersion)}`);
  }
  if (!SEMVER.test(input.appVersion))
    throw new Error(`invalid appVersion ${input.appVersion}`);
  if (!SEMVER.test(input.srtVersion))
    throw new Error(`invalid srtVersion ${JSON.stringify(input.srtVersion)}`);

  const names = readdirSync(input.bundleDir)
    .filter((name) => name !== MANIFEST_FILENAME)
    .sort();
  if (names.length === 0)
    throw new Error(`no files in bundle directory ${input.bundleDir}`);
  const files: Manifest["files"] = {};
  for (const name of names) {
    const path = join(input.bundleDir, name);
    if (!lstatSync(path).isFile()) {
      throw new Error(`bundle entry ${name} is not a regular file`);
    }
    const bytes = readFileSync(path);
    files[name] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
  return {
    schemaVersion: 1,
    protocolVersion: input.protocolVersion,
    appVersion: input.appVersion,
    target: input.target,
    srtVersion: input.srtVersion,
    files,
  };
}
