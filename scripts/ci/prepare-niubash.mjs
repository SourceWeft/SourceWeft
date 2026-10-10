import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const niubashVersion = "1.3.3";
export const niubashSha256 =
  "6538d915db05d1090ce1e664438e7268fe331407e31f9240b901ecfb609b619c";
const root = fileURLToPath(new URL("../../", import.meta.url));
export const niubashDirectory = join(
  root,
  "apps/desktop/src-tauri/resources/niubash",
);

export function verifyNiubashArchive(bytes) {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    niubashSha256,
    "niubash archive SHA-256 mismatch",
  );
}

export async function prepareNiubash(archivePath) {
  assert.equal(process.platform, "win32", "niubash packaging requires Windows");
  assert.equal(
    process.arch,
    "x64",
    "The pinned niubash bundle requires Windows x64",
  );
  const cache = join(root, "apps/desktop/src-tauri/target/niubash");
  await mkdir(cache, { recursive: true });
  const asset = `niubash-v${niubashVersion}-win-x64.zip`;
  const cachedArchive = join(cache, asset);
  let bytes;
  if (archivePath) {
    bytes = await readFile(archivePath);
  } else {
    try {
      bytes = await readFile(cachedArchive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(
        `https://github.com/unixwin/niubash/releases/download/v${niubashVersion}/${asset}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      assert(response.ok, `niubash download failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
  }
  verifyNiubashArchive(bytes);
  await writeFile(cachedArchive, bytes);
  const staging = await mkdtemp(join(cache, "extract-"));
  try {
    const tar = join(process.env.SystemRoot, "System32", "tar.exe");
    const extracted = spawnSync(tar, ["-xf", cachedArchive, "-C", staging], {
      encoding: "utf8",
    });
    if (extracted.error) throw extracted.error;
    assert.equal(
      extracted.status,
      0,
      `niubash extraction failed: ${extracted.stderr}`,
    );
    const distribution = join(staging, `niubash-v${niubashVersion}-win-x64`);
    await cp(
      join(root, "apps/desktop/third-party/niubash-LICENSE.txt"),
      join(distribution, "LICENSE.txt"),
    );
    await writeFile(
      join(distribution, "SOURCEWEFT-NOTICE.txt"),
      `niubash ${niubashVersion}\nhttps://github.com/unixwin/niubash/tree/v${niubashVersion}\nOfficial archive SHA-256: ${niubashSha256}\nDistributed under the accompanying MIT license.\n`,
    );
    // Package the official portable files. niubash creates command hardlinks on
    // first launch; packaging generated aliases as separate files would inflate
    // installed disk usage by hundreds of MiB.
    await mkdir(dirname(niubashDirectory), { recursive: true });
    await rm(niubashDirectory, { recursive: true, force: true });
    await cp(distribution, niubashDirectory, { recursive: true });
    const probeDirectory = join(staging, "probe");
    await cp(distribution, probeDirectory, { recursive: true });
    // Probe with no installed niubash/tool PATH, including its bundled utilities.
    const probe = spawnSync(
      join(probeDirectory, "niu.exe"),
      ["-c", "printf niubash-bundled-ok | cat"],
      {
        encoding: "utf8",
        cwd: staging,
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: "",
        },
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (probe.error) throw probe.error;
    assert.equal(
      probe.status,
      0,
      `niubash bundled smoke failed: ${probe.stderr}`,
    );
    assert.equal(probe.stdout, "niubash-bundled-ok");
  } finally {
    // Antivirus/process teardown may briefly retain Windows executable handles.
    await rm(staging, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  console.log(`Bundled niubash ${niubashVersion} prepared and verified`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert(
    process.argv.length === 2 ||
      (process.argv.length === 4 && process.argv[2] === "--archive"),
    "Usage: node prepare-niubash.mjs [--archive <verified official zip>]",
  );
  await prepareNiubash(process.argv[3]);
}
