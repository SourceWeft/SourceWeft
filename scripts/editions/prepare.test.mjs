import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "billing-edition-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "source");
  await mkdir(path.join(root, "scripts/editions"), { recursive: true });
  await mkdir(path.join(root, "apps/backend/node_modules"), {
    recursive: true,
  });
  await cp(
    new URL("./prepare.mjs", import.meta.url),
    path.join(root, "scripts/editions/prepare.mjs"),
  );
  await writeFile(path.join(root, "package.json"), '{"private":true}\n');
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n  - packages/*\n",
  );
  await writeFile(
    path.join(root, "apps/backend/.env"),
    "SECRET=must-not-be-copied\n",
  );
  await writeFile(path.join(root, "apps/backend/.env.example"), "SECRET=\n");
  await writeFile(
    path.join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
  await writeFile(path.join(root, "LICENSE"), "Fixture license\n");
  return {
    temp,
    root,
    run: (...args) =>
      execute(process.execPath, [
        path.join(root, "scripts/editions/prepare.mjs"),
        ...args,
      ]),
  };
}

test("core preparation requires no enterprise tree and omits credentials and installed modules", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.temp, "core");
  await f.run("--edition=core", `--out=${output}`);
  assert.equal(
    await readFile(path.join(output, "apps/backend/.env.example"), "utf8"),
    "SECRET=\n",
  );
  await assert.rejects(readFile(path.join(output, "apps/backend/.env")));
  await assert.rejects(stat(path.join(output, "apps/backend/node_modules")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(output, "enterprise/package.json")));
});

test("a requested commercial build fails instead of preparing core when its package is missing", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run("--edition=commercial", `--out=${path.join(f.temp, "commercial")}`),
  );
});

test("replacement is explicit and removes stale source files", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.temp, "core");
  await f.run(`--out=${output}`);
  await writeFile(
    path.join(output, "apps/backend/stale.ts"),
    "commercial-code",
  );
  await assert.rejects(f.run(`--out=${output}`));
  await f.run(`--out=${output}`, "--replace=true");
  await assert.rejects(readFile(path.join(output, "apps/backend/stale.ts")));
});

test("a symlinked output ancestor cannot overwrite the source tree", async (t) => {
  const f = await fixture(t);
  await symlink(f.root, path.join(f.temp, "alias"));
  await assert.rejects(f.run(`--out=${path.join(f.temp, "alias", "nested")}`));
  assert.equal(
    await readFile(path.join(f.root, "package.json"), "utf8"),
    '{"private":true}\n',
  );
});

test("a descendant whose name starts with dots is still inside the source", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(`--out=${path.join(f.root, "..hidden")}`));
});

test("commercial preparation requires complete bindings and applies its scripts and version constraints", async (t) => {
  const f = await fixture(t);
  const enterprise = path.join(f.root, "enterprise");
  const editionDir = path.join(enterprise, "billing/edition");
  await mkdir(editionDir, { recursive: true });
  await mkdir(path.join(f.root, "apps/web"), { recursive: true });
  await writeFile(
    path.join(enterprise, "LICENSE"),
    "Commercial fixture license",
  );
  await writeFile(
    path.join(enterprise, "billing/package.json"),
    '{"name":"@sourceweft/billing"}',
  );
  const manifestPath = path.join(editionDir, "manifest.json");
  await writeFile(manifestPath, '{"dependencies":{},"bindings":{}}');
  await assert.rejects(
    f.run("--edition=commercial", `--out=${path.join(f.temp, "incomplete")}`),
    /dependency binding is missing/,
  );
  for (const app of ["backend", "web"])
    await writeFile(
      path.join(f.root, `apps/${app}/package.json`),
      JSON.stringify({ name: app }),
    );
  const destinations = [
    "apps/backend/src/billing-host/bindings.ts",
    "apps/web/lib/billing-edition/client.tsx",
    "apps/web/lib/billing-edition/auth-client.ts",
    "apps/web/lib/billing-edition/catalog.ts",
  ];
  const bindings = {};
  for (const [index, dest] of destinations.entries()) {
    const name = `binding-${index}.ts`;
    bindings[dest] = name;
    await writeFile(
      path.join(editionDir, name),
      'export const edition = "commercial";',
    );
  }
  await writeFile(
    path.join(editionDir, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
  await writeFile(
    manifestPath,
    JSON.stringify({
      bindings,
      dependencies: {
        "apps/backend/package.json": { "@sourceweft/billing": "workspace:*" },
        "apps/web/package.json": { "@sourceweft/billing": "workspace:*" },
      },
      scripts: {
        "apps/backend/package.json": { "billing:check": "node check.js" },
      },
      overrides: { creem: "1.6.0" },
    }),
  );
  const output = path.join(f.temp, "commercial");
  await f.run("--edition=commercial", `--out=${output}`);
  const backend = JSON.parse(
    await readFile(path.join(output, "apps/backend/package.json"), "utf8"),
  );
  assert.equal(backend.dependencies["@sourceweft/billing"], "workspace:*");
  assert.equal(backend.scripts["billing:check"], "node check.js");
  const rootManifest = JSON.parse(
    await readFile(path.join(output, "package.json"), "utf8"),
  );
  assert.equal(rootManifest.pnpm.overrides.creem, "1.6.0");
});
