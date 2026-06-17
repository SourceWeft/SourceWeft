import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  parseCapabilityManifest,
  type CapabilityDiagnostic,
} from "@sourceweft/capability-contracts";
import type {
  CapabilityDiscoveryResult,
  DiscoveredCapabilityRecord,
} from "./types";

type DiscoverCapabilitiesInput = {
  readonly roots: readonly string[];
};

type PackageJson = {
  readonly name?: unknown;
};

export async function discoverCapabilities(
  input: DiscoverCapabilitiesInput,
): Promise<CapabilityDiscoveryResult> {
  const candidates = await findManifestCandidates(input.roots);
  const records: DiscoveredCapabilityRecord[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];

  for (const manifestPath of candidates) {
    const rawManifest = await readJson(manifestPath);
    const parsed = parseCapabilityManifest(rawManifest);
    if (!parsed.ok) {
      diagnostics.push(
        ...parsed.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          source: manifestPath,
        })),
      );
      continue;
    }

    const pathDiagnostic = await validateEntryPath(
      dirname(manifestPath),
      parsed.manifest.entry,
      manifestPath,
      parsed.manifest.id,
    );
    if (pathDiagnostic) {
      diagnostics.push(pathDiagnostic);
      continue;
    }

    records.push({
      manifest: parsed.manifest,
      rootDir: dirname(manifestPath),
      manifestPath,
      packageName: await readPackageName(dirname(manifestPath)),
    });
  }

  return {
    records: records.sort((left, right) =>
      left.manifest.id.localeCompare(right.manifest.id),
    ),
    diagnostics,
  };
}

async function findManifestCandidates(
  roots: readonly string[],
): Promise<readonly string[]> {
  const manifests: string[] = [];
  for (const root of roots) {
    const absoluteRoot = resolve(root);
    const rootEntries = await readdir(absoluteRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageRoot = join(absoluteRoot, entry.name);
      const manifestPath = join(packageRoot, "sourceweft.capability.json");
      try {
        await readFile(manifestPath, "utf8");
        manifests.push(manifestPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }
  }
  return manifests.sort((left, right) => left.localeCompare(right));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readPackageName(packageRoot: string): Promise<string | null> {
  try {
    const packageJson = (await readJson(
      join(packageRoot, "package.json"),
    )) as PackageJson;
    return typeof packageJson.name === "string" ? packageJson.name : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function validateEntryPath(
  packageRoot: string,
  entry: string | undefined,
  source: string,
  capabilityId: string,
): Promise<CapabilityDiagnostic | null> {
  if (!entry) {
    return null;
  }
  const rootRealpath = await realpath(packageRoot);
  const entryPath = resolve(packageRoot, entry);
  const expectedPrefix = rootRealpath.endsWith(sep)
    ? rootRealpath
    : `${rootRealpath}${sep}`;
  const parentRealpath = await realpath(dirname(entryPath)).catch(() =>
    dirname(entryPath),
  );
  if (
    entryPath === rootRealpath ||
    parentRealpath === rootRealpath ||
    parentRealpath.startsWith(expectedPrefix)
  ) {
    return null;
  }
  return {
    level: "error",
    code: "path.escape",
    message: `Capability entry escapes package root: ${entry}`,
    source,
    capabilityId,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
