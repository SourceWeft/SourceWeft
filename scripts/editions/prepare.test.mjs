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
