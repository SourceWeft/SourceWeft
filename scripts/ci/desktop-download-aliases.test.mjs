import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerSuffixes, prepareAliases } from "./desktop-download-aliases.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "desktop-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input);
  for (const suffix of installerSuffixes) {
    await writeFile(join(input, `SourceWeft_0.3.0-rc.6_${suffix}`), `installer bytes ${suffix}`);
  }
  return { input, output };
}

test("aliases preserve installer bytes and originals, and can be regenerated", async (t) => {
  const { input, output } = await fixture(t);
  await writeFile(join(input, "SourceWeft.app.tar.gz.sig"), "updater signature");
  for (let run = 0; run < 2; run++) {
    const copies = await prepareAliases(input, output, "v0.3.0-rc.6");
    assert.equal(copies.length, 3);
    for (const copy of copies) assert.deepEqual(await readFile(copy.destination), await readFile(copy.source));
  }
  assert.equal((await readdir(input)).length, 4);
  assert.equal((await readdir(output)).length, 3);
});

for (const problem of ["missing", "duplicate", "empty", "wrong-version"]) {
  test(`rejects ${problem} installers before writing aliases`, async (t) => {
    const { input, output } = await fixture(t);
    const name = "SourceWeft_0.3.0-rc.6_x64-setup.exe";
    if (problem === "missing") await rm(join(input, name));
    if (problem === "empty") await writeFile(join(input, name), "");
    if (problem === "duplicate") {
      await mkdir(join(input, "nested"));
      await writeFile(join(input, "nested", name), "duplicate");
    }
    await assert.rejects(prepareAliases(input, output, problem === "wrong-version" ? "v0.3.0-rc.7" : "v0.3.0-rc.6"), /Expected exactly one|Empty installer/);
    await assert.rejects(readdir(output), { code: "ENOENT" });
  });
}

test("cannot add aliases to the original artifact tree", async (t) => {
  const { input } = await fixture(t);
  for (const output of [input, join(input, "aliases")]) {
    await assert.rejects(prepareAliases(input, output, "v0.3.0-rc.6"), /outside/);
  }
});
