import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function digest(stream) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

export async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(
      !entry.isSymbolicLink(),
      `Symlinks are not release artifacts: ${path}`,
    );
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export async function describeInstaller(directory, platform, arch, version) {
  assert(
    ["darwin", "win32"].includes(platform),
    "Unsupported desktop platform",
  );
  assert(["arm64", "x64"].includes(arch), "Unsupported desktop architecture");
  const extension = platform === "darwin" ? ".dmg" : ".exe";
  const files = (await filesUnder(directory)).filter((path) =>
    path.endsWith(extension),
  );
  assert.equal(files.length, 1, `Expected exactly one ${extension} installer`);
  const path = files[0];
  assert((await stat(path)).size > 0, "Installer cannot be empty");
  return {
    schemaVersion: 1,
    version,
    platform: platform === "darwin" ? "macos" : "windows",
    arch,
    filename: basename(path),
    ...(await digest(createReadStream(path))),
    distributionSigned: false,
    notarized: false,
    localExecutionSupported: platform === "darwin",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { readFile } = await import("node:fs/promises");
  const { version } = JSON.parse(
    await readFile("apps/desktop/package.json", "utf8"),
  );
  // The workflow builds the host target, without --target. Capture the actual
  // runner architecture instead of assuming what macos-latest resolves to.
  const entry = await describeInstaller(
    "apps/desktop/src-tauri/target/release/bundle",
    process.platform,
    process.arch,
    version,
  );
  await writeFile(
    `desktop-manifest-${entry.platform}-${entry.arch}.json`,
    JSON.stringify(entry, null, 2) + "\n",
  );
}
