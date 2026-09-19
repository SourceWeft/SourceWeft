import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { digest } from "./desktop-release-artifacts.mjs";
import {
  UPDATE_TARGETS,
  MAX_UPDATE_SIZE,
  verifyUpdateSignature,
  updateExtension,
} from "./desktop-update-manifest.mjs";

const target = process.env.DESKTOP_RELEASE_TARGET;
assert(UPDATE_TARGETS[target], "Explicit DESKTOP_RELEASE_TARGET is required");
const mac = target.endsWith("apple-darwin");
const linux = target.endsWith("unknown-linux-gnu");
assert.equal(
  process.platform,
  mac ? "darwin" : linux ? "linux" : "win32",
  "Signing verification requires the target OS",
);
const { version } = JSON.parse(
  await readFile("apps/desktop/package.json", "utf8"),
);
const bundle = `apps/desktop/src-tauri/target/${target}/release/bundle`;
// AppDir and app bundles may contain framework symlinks; enumerate only the
// actual artifact directories and never recursively treat an AppDir as input.
const artifactDirectories = mac
  ? ["dmg", "macos"]
  : [linux ? "appimage" : "nsis"];
const files = [];
for (const dir of artifactDirectories) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(join(bundle, dir), {
    withFileTypes: true,
  })) {
    if (entry.isFile()) files.push(join(bundle, dir, entry.name));
    else assert(entry.isDirectory(), "Symlinks are not release artifacts");
  }
}
const one = (extension) => {
  const matches = files.filter((path) => path.endsWith(extension));
  assert.equal(matches.length, 1, `Expected one ${extension}`);
  return matches[0];
};
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Distribution verification failed: ${result.stderr}`,
  );
};
if (mac) {
  const app = `apps/desktop/src-tauri/target/${target}/release/bundle/macos/SourceWeft.app`;
  run("codesign", ["--verify", "--deep", "--strict", app]);
  run("spctl", ["--assess", "--type", "execute", app]);
  run("xcrun", ["stapler", "validate", app]);
  run("hdiutil", ["verify", one(".dmg")]);
} else if (linux) {
  const file = await open(one(".AppImage"), "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    assert(
      bytesRead === 64 &&
        header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === 62,
      "Expected x86_64 ELF AppImage",
    );
    assert(
      header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])),
      "Expected type-2 AppImage",
    );
    assert((await file.stat()).mode & 0o111, "AppImage must be executable");
  } finally {
    await file.close();
  }
} else {
  run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$s=Get-AuthenticodeSignature -LiteralPath $env:UPDATE_VERIFY_INSTALLER; if($s.Status -ne 'Valid'){throw 'Invalid Authenticode signature'}",
  ]);
}
const output = "desktop-release";
await mkdir(output, { recursive: true });
const name = `SourceWeft_${version}_${UPDATE_TARGETS[target]}`;
const updateSuffix = updateExtension(UPDATE_TARGETS[target]);
const installerSuffix = mac ? ".dmg" : updateSuffix;
const installerName = `${name}${installerSuffix}`;
const updateName = `${name}${updateSuffix}`;
const installerSource = one(installerSuffix);
const updateSource = one(updateSuffix);
await verifyUpdateSignature(updateSource, `${updateSource}.sig`);
await copyFile(installerSource, join(output, installerName));
if (mac) await copyFile(updateSource, join(output, updateName));
await copyFile(`${updateSource}.sig`, join(output, `${updateName}.sig`));
const common = {
  schemaVersion: 1,
  version,
  distributionSigned: !linux,
  notarized: mac,
};
const installer = {
  ...common,
  platform: mac ? "macos" : linux ? "linux" : "windows",
  arch: target.startsWith("aarch64") ? "arm64" : "x64",
  filename: installerName,
  localExecutionSupported: mac,
  ...(await digest(createReadStream(installerSource))),
};
const update = {
  ...common,
  target,
  filename: updateName,
  ...(await digest(createReadStream(updateSource))),
};
assert(update.size <= MAX_UPDATE_SIZE, "Release update exceeds 512 MiB");
await writeFile(
  join(output, `desktop-manifest-${target}.json`),
  JSON.stringify(installer, null, 2) + "\n",
);
await writeFile(
  join(output, `desktop-update-${target}.json`),
  JSON.stringify(update, null, 2) + "\n",
);
