import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import en from "../messages/en.json";
import {
  CLIENT_NAMESPACES,
  pickMessages,
  type ClientMessageArea,
} from "./client-messages";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(webRoot, "app");

/** Route directory under `app/` -> the provider that serves it. Everything else uses the root provider. */
const AREA_DIRS: Record<string, ClientMessageArea> = {
  "[locale]": "marketing",
  auth: "auth",
  dashboard: "dashboard",
  "artifact-preview": "artifactPreview",
};

/**
 * Calls whose namespace is not a string literal. Each needs a reviewed reason,
 * because the check cannot see which namespace they read.
 */
const NON_LITERAL_ALLOWED: Record<string, string> = {
  "app/providers.tsx":
    "useMessages() hands messages.authLocale to Better Auth; authLocale is in the root namespaces",
};

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function resolveImport(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? join(webRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (isFile(base + suffix) && /\.tsx?$/.test(base + suffix)) {
      return base + suffix;
    }
  }
  return undefined;
}

const clientCache = new Map<string, boolean>();
function isClientModule(file: string): boolean {
  let cached = clientCache.get(file);
  if (cached === undefined) {
    cached =
      /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(
        readFileSync(file, "utf8"),
      );
    clientCache.set(file, cached);
  }
  return cached;
}

/**
 * Files that end up in the browser bundle: every `"use client"` module reachable
 * from the entries through imports (server modules are only walked to find those
 * boundaries), plus everything such a module imports.
 */
function clientFiles(entries: string[]): Set<string> {
  const visited = new Map<string, boolean>();
  const queue: Array<[string, boolean]> = entries.map((file) => [file, false]);
  while (queue.length > 0) {
    const [file, inClient] = queue.pop()!;
    const client = inClient || isClientModule(file);
    const previous = visited.get(file);
    if (previous === true || previous === client) continue;
    visited.set(file, client);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g,
    )) {
      const target = resolveImport(file, match[1]!);
      if (target && !/\.test\./.test(target)) queue.push([target, client]);
    }
  }
  return new Set([...visited].filter(([, client]) => client).map(([f]) => f));
}

function usedNamespaces(files: Set<string>): {
  namespaces: Set<string>;
  nonLiteral: string[];
} {
  const namespaces = new Set<string>();
  const nonLiteral: string[] = [];
  for (const file of files) {
    const rel = relative(webRoot, file);
    for (const match of readFileSync(file, "utf8").matchAll(
      /\buse(?:Translations|Messages)\(([^)]*)\)/g,
    )) {
      const literal = match[1]!.trim().match(/^["']([\w.]+)["']$/);
      if (literal) namespaces.add(literal[1]!);
      else if (!(rel in NON_LITERAL_ALLOWED)) {
        nonLiteral.push(`${rel}: ${match[0]}`);
      }
    }
  }
  return { namespaces, nonLiteral };
}

function hasPage(dir: string): boolean {
  return sourceFiles(dir).some((f) => /\/page\.tsx$/.test(f));
}

/** Entry files per provider area, derived from the directory layout. */
function areaEntries(): Record<ClientMessageArea, string[]> {
  const entries: Record<ClientMessageArea, string[]> = {
    root: [],
    marketing: [],
    auth: [],
    dashboard: [],
    artifactPreview: [],
  };
  for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
    const path = join(appRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_")) continue; // shared modules, reached via imports
      const area = AREA_DIRS[entry.name];
      if (area) entries[area].push(...sourceFiles(path));
      else if (hasPage(path)) entries.root.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      if (entry.name !== "global-error.tsx") entries.root.push(path);
    }
  }
  return entries;
}

function covers(provided: readonly string[], needed: string): boolean {
  return provided.some((p) => needed === p || needed.startsWith(`${p}.`));
}

const areas = Object.keys(CLIENT_NAMESPACES) as ClientMessageArea[];

test.each(areas)(
  "%s provider ships every namespace its client components read",
  (area) => {
    const files = clientFiles(areaEntries()[area]);
    expect(files.size).toBeGreaterThan(0);
    const { namespaces, nonLiteral } = usedNamespaces(files);

    expect(nonLiteral).toEqual([]);
    const missing = [...namespaces]
      .filter((ns) => !covers(CLIENT_NAMESPACES[area], ns))
      .sort();
    expect(missing).toEqual([]);
  },
  // Walks the import graph of a whole route area from disk.
  60_000,
);

test("every shipped namespace exists in the catalog", () => {
  // `pricing` is added to the catalog by `i18n/request.ts`, not `en.json`.
  const catalog = {
    ...en,
    pricing: {},
  } as unknown as Record<string, unknown>;
  for (const area of areas) {
    for (const ns of CLIENT_NAMESPACES[area]) {
      if (ns === "pricing") continue;
      const picked = pickMessages(catalog, [ns]);
      expect(Object.keys(picked), `${area}: ${ns}`).not.toHaveLength(0);
    }
  }
});

test("pickMessages keeps only the requested sub-trees", () => {
  const messages = {
    a: { x: "1", y: { z: "2" } },
    b: { c: "3" },
    d: "4",
  };
  expect(pickMessages(messages, ["a.y", "b", "missing.path"])).toEqual({
    a: { y: { z: "2" } },
    b: { c: "3" },
  });
  expect(pickMessages(messages, ["a.y", "a"])).toEqual({
    a: { x: "1", y: { z: "2" } },
  });
});

test("nested providers are wired in the layouts of the areas that define them", () => {
  const wired: Record<string, ClientMessageArea> = {
    "[locale]/layout.tsx": "marketing",
    "auth/layout.tsx": "auth",
    "dashboard/layout.tsx": "dashboard",
    "artifact-preview/layout.tsx": "artifactPreview",
  };
  for (const [layout, area] of Object.entries(wired)) {
    expect(readFileSync(join(appRoot, layout), "utf8")).toContain(
      `area="${area}"`,
    );
  }
  expect(readFileSync(join(appRoot, "layout.tsx"), "utf8")).toContain(
    `pickMessages(await getMessages(), CLIENT_NAMESPACES.root)`,
  );
});
