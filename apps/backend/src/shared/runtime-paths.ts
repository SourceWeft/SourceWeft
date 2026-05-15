import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_PACKAGE_NAME = "@sourceweft/backend";

const currentModuleDir = path.dirname(fileURLToPath(import.meta.url));

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function isBackendPackageRoot(directory: string) {
  const packageJsonPath = path.join(directory, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };
    return packageJson.name === BACKEND_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function findBackendPackageRoot(start: string) {
  let current = path.resolve(start);

  while (true) {
    if (isBackendPackageRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function backendRootCandidates() {
  const explicitRoot =
    process.env.SOURCEWEFT_BACKEND_ROOT?.trim() ||
    process.env.BACKEND_ROOT?.trim() ||
    "";
  const starts = unique(
    [
      explicitRoot,
      process.cwd(),
      path.join(process.cwd(), "apps/backend"),
      currentModuleDir,
      path.join(currentModuleDir, ".."),
      path.join(currentModuleDir, "../.."),
    ].filter(Boolean),
  );

  return unique(
    starts
      .map((start) => findBackendPackageRoot(start))
      .filter((root): root is string => Boolean(root)),
  );
}

function preferSourceCandidates() {
  return currentModuleDir.split(path.sep).includes("src");
}

function orderRuntimePathCandidates(candidates: string[]) {
  if (!preferSourceCandidates()) {
    return candidates;
  }

  return [...candidates].sort((left, right) => {
    const leftScore = left.startsWith("src/") ? 0 : 1;
    const rightScore = right.startsWith("src/") ? 0 : 1;
    return leftScore - rightScore;
  });
}

export function resolveBackendRuntimePath(input: {
  candidates: string[];
  envVar?: string;
  label: string;
}) {
  const configured = input.envVar ? process.env[input.envVar]?.trim() : "";
  if (configured) {
    return path.resolve(configured);
  }

  const roots = backendRootCandidates();
  const candidates = orderRuntimePathCandidates(input.candidates);
  for (const root of roots) {
    for (const candidate of candidates) {
      const resolved = path.resolve(root, candidate);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
  }

  throw new Error(
    `Unable to resolve ${input.label}. Checked ${input.candidates.join(
      ", ",
    )} under backend package roots.`,
  );
}
