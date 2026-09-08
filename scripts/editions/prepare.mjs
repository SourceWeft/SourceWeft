import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = await realpath(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(edition|out|refresh-lockfile|replace)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    return [match[1], match[2]];
  }),
);
const edition = options.edition ?? "core";
if (edition !== "core" && edition !== "commercial")
  throw new Error("edition must be core or commercial");
for (const name of ["refresh-lockfile", "replace"]) {
  if (options[name] !== undefined && !["true", "false"].includes(options[name]))
    throw new Error(`${name} must be true or false`);
}
if (!options.out) throw new Error("An explicit --out directory is required");
const requestedOutput = path.resolve(options.out);
// Canonicalize the existing ancestor too: a parent symlink must not turn an
// apparently external output path into a path inside the source workspace.
let ancestor = path.dirname(requestedOutput);
const suffix = [path.basename(requestedOutput)];
while (true) {
  try {
    ancestor = await realpath(ancestor);
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
}
const output = path.join(ancestor, ...suffix);
const relative = path.relative(sourceRoot, output);
if (relative !== ".." && !relative.startsWith(".." + path.sep))
  throw new Error("Output must be outside the source workspace");
if (
  sourceRoot.startsWith(output + path.sep) ||
  output === path.parse(output).root
)
  throw new Error("Unsafe output directory");
const marker = ".sourceweft-edition.json";
let existing;
try {
  existing = await lstat(output);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing) {
  if (!existing.isDirectory() || existing.isSymbolicLink())
    throw new Error("Output must be a real directory");
  const owned = JSON.parse(await readFile(path.join(output, marker), "utf8"));
  if (owned.sourceRoot !== sourceRoot || owned.edition !== edition)
    throw new Error("Output is not owned by this edition preparation");
  if (options.replace !== "true")
    throw new Error(
      "Output already exists; --replace=true explicitly replaces this generated workspace",
    );
}
// A locked, licensed source tree is required before any existing output is removed.
for (const required of [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "LICENSE",
]) {
  await lstat(path.join(sourceRoot, required));
}
// Validate commercial inputs before touching an existing prepared workspace.
let commercial;
if (edition === "commercial") {
  commercial = JSON.parse(
    await readFile(
      path.join(sourceRoot, "enterprise/billing/edition/manifest.json"),
      "utf8",
    ),
  );
  await lstat(path.join(sourceRoot, "enterprise/billing/package.json"));
  await lstat(path.join(sourceRoot, "enterprise/LICENSE"));
  for (const app of ["backend", "web"]) {
    if (
      commercial.dependencies?.[`apps/${app}/package.json`]?.[
        "@sourceweft/billing"
      ] !== "workspace:*"
    ) {
      throw new Error(`Commercial ${app} dependency binding is missing`);
    }
  }
  for (const binding of [
    "apps/backend/src/billing-host/bindings.ts",
    "apps/web/lib/billing-edition/client.tsx",
    "apps/web/lib/billing-edition/auth-client.ts",
    "apps/web/lib/billing-edition/catalog.ts",
  ]) {
    if (!commercial.bindings?.[binding])
      throw new Error(`Commercial binding is missing: ${binding}`);
  }
  for (const file of Object.keys({
    ...commercial.dependencies,
    ...commercial.scripts,
  })) {
    if (!/^apps\/[a-z0-9-]+\/package\.json$/.test(file))
      throw new Error("Invalid dependency manifest destination");
  }
  for (const [destination, template] of Object.entries(commercial.bindings)) {
    if (
      !destination.startsWith("apps/") ||
      path.isAbsolute(template) ||
      template.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid binding path");
    const dest = path.resolve(output, destination);
    if (!dest.startsWith(output + path.sep))
      throw new Error("Binding escapes output");
  }
  if (options["refresh-lockfile"] !== "true")
    await lstat(
      path.join(sourceRoot, "enterprise/billing/edition/pnpm-lock.yaml"),
    );
}
if (existing) await rm(output, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, marker),
  JSON.stringify({ sourceRoot, edition }, null, 2) + "\n",
);
const allowed = [
  "apps",
  "packages",
  "scripts",
  "patches",
  "docker",
  ".github",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "turbo.json",
  "Dockerfile",
  ".npmrc",
  ".dockerignore",
  ".gitignore",
];
const excluded = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  ".git",
  ".output",
  ".wxt",
  "target",
  "output",
]);
async function copy(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async (entry) => {
      const name = path.basename(entry);
      if (
        excluded.has(name) ||
        (name.startsWith(".env") && !name.endsWith(".example")) ||
        name.endsWith(".tsbuildinfo")
      )
        return false;
      if ((await lstat(entry)).isSymbolicLink())
        throw new Error(
          `Source symlinks are not permitted: ${path.relative(sourceRoot, entry)}`,
        );
      return true;
    },
  });
}
for (const name of allowed) {
  const source = path.join(sourceRoot, name);
  let stat;
  try {
    stat = await lstat(source);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const destination = path.join(output, name);
  await copy(source, destination);
}
if (commercial) {
  await copy(
    path.join(sourceRoot, "enterprise"),
    path.join(output, "enterprise"),
  );
  const workspacePath = path.join(output, "pnpm-workspace.yaml");
  const workspace = await readFile(workspacePath, "utf8");
  await writeFile(
    workspacePath,
    workspace.replace("packages:\n", "packages:\n  - enterprise/*\n"),
  );
  if (commercial.overrides) {
    const rootManifestPath = path.join(output, "package.json");
    const manifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
    manifest.pnpm = {
      ...manifest.pnpm,
      overrides: { ...manifest.pnpm?.overrides, ...commercial.overrides },
    };
    await writeFile(rootManifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  for (const [file, additions] of Object.entries(commercial.dependencies)) {
    const manifestPath = path.join(output, file);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = { ...manifest.dependencies, ...additions };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  for (const [file, scripts] of Object.entries(commercial.scripts ?? {})) {
    const manifestPath = path.join(output, file);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts = { ...manifest.scripts, ...scripts };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  for (const [destination, template] of Object.entries(commercial.bindings)) {
    const dest = path.resolve(output, destination);
    if (!dest.startsWith(output + path.sep))
      throw new Error("Binding escapes output");
    await mkdir(path.dirname(dest), { recursive: true });
    await copy(
      path.join(sourceRoot, "enterprise/billing/edition", template),
      dest,
    );
  }
  if (options["refresh-lockfile"] !== "true") {
    await copy(
      path.join(sourceRoot, "enterprise/billing/edition/pnpm-lock.yaml"),
      path.join(output, "pnpm-lock.yaml"),
    );
  }
}
console.log(`Prepared ${edition} source workspace: ${output}`);
