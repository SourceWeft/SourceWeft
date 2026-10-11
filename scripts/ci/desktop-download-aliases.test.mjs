import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installerSuffixes,
  prepareAliases,
} from "./desktop-download-aliases.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "desktop-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input);
  for (const suffix of installerSuffixes) {
    await writeFile(
      join(input, `SourceWeft_0.3.0-rc.6_${suffix}`),
      `installer bytes ${suffix}`,
    );
  }
  return { input, output };
}

test("aliases preserve installer bytes and originals, and can be regenerated", async (t) => {
  const { input, output } = await fixture(t);
  await writeFile(
    join(input, "SourceWeft.app.tar.gz.sig"),
    "updater signature",
  );
  for (let run = 0; run < 2; run++) {
    const copies = await prepareAliases(input, output, "v0.3.0-rc.6");
    assert.equal(copies.length, 3);
    for (const copy of copies)
      assert.deepEqual(
        await readFile(copy.destination),
        await readFile(copy.source),
      );
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
    await assert.rejects(
      prepareAliases(
        input,
        output,
        problem === "wrong-version" ? "v0.3.0-rc.7" : "v0.3.0-rc.6",
      ),
      /Expected exactly one|Empty installer/,
    );
    await assert.rejects(readdir(output), { code: "ENOENT" });
  });
}

test("cannot add aliases to the original artifact tree", async (t) => {
  const { input } = await fixture(t);
  for (const output of [input, join(input, "aliases")]) {
    await assert.rejects(
      prepareAliases(input, output, "v0.3.0-rc.6"),
      /outside/,
    );
  }
});

const canonicalInstallers = {
  "darwin-aarch64.dmg": "Mac ARM bytes",
  "darwin-x86_64.dmg": "Mac Intel bytes",
  "windows-x86_64.exe": "Windows bytes",
  "linux-x86_64.AppImage": "Linux bytes",
};
for (const policy of ["signed", "updater-signed"]) {
  test(`${policy} canonical installer names produce all four aliases without changing bytes`, async (t) => {
    const { input, output } = await fixture(t);
    for (const file of await readdir(input)) await rm(join(input, file));
    for (const [source, bytes] of Object.entries(canonicalInstallers)) {
      await writeFile(join(input, `SourceWeft_0.3.0-rc.7_${source}`), bytes);
    }
    await writeFile(
      join(input, "SourceWeft_0.3.0-rc.7_darwin-aarch64.app.tar.gz.sig"),
      "unchanged signature",
    );
    const copies = await prepareAliases(input, output, "v0.3.0-rc.7", policy);
    assert.equal(copies.length, 4);
    assert.equal(
      await readFile(join(output, "SourceWeft_aarch64.dmg"), "utf8"),
      "Mac ARM bytes",
    );
    assert.equal(
      await readFile(join(output, "SourceWeft_x64.dmg"), "utf8"),
      "Mac Intel bytes",
    );
    assert.equal(
      await readFile(join(output, "SourceWeft_x64-setup.exe"), "utf8"),
      "Windows bytes",
    );
    assert.equal(
      await readFile(join(output, "SourceWeft_amd64.AppImage"), "utf8"),
      "Linux bytes",
    );
    assert.deepEqual(
      (await readdir(output)).sort(),
      [
        "SourceWeft_aarch64.dmg",
        "SourceWeft_x64.dmg",
        "SourceWeft_x64-setup.exe",
        "SourceWeft_amd64.AppImage",
      ].sort(),
    );
    for (const copy of copies)
      assert.deepEqual(
        await readFile(copy.source),
        await readFile(copy.destination),
      );
    assert.equal((await readdir(input)).length, 5);
  });
}

test("missing Intel installer and mixed modes are rejected rather than falling back", async (t) => {
  const { input, output } = await fixture(t);
  await assert.rejects(
    prepareAliases(input, output, "v0.3.0-rc.6", "updater-signed"),
    /Expected exactly one/,
  );
  for (const file of await readdir(input)) await rm(join(input, file));
  for (const source of Object.keys(canonicalInstallers).filter(
    (source) => source !== "darwin-x86_64.dmg",
  ))
    await writeFile(join(input, `SourceWeft_0.3.0-rc.7_${source}`), "original");
  await assert.rejects(
    prepareAliases(input, output, "v0.3.0-rc.7", "updater-signed"),
    /darwin-x86_64/,
  );
  await assert.rejects(readdir(output), { code: "ENOENT" });
  await assert.rejects(
    prepareAliases(input, output, "v0.3.0-rc.7", "unknown"),
    /policy/,
  );
});
