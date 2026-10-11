import assert from "node:assert/strict";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { filesUnder } from "./desktop-release-artifacts.mjs";
import { releaseVersion, publicationTag } from "./verify-release-config.mjs";
import { desktopPublicationPolicy } from "./desktop-publication-policy.mjs";

export const installerSuffixes = [
  "aarch64.dmg",
  "x64-setup.exe",
  "amd64.AppImage",
];

export function aliasSpecs(policy = "candidate") {
  desktopPublicationPolicy(policy);
  return policy === "candidate"
    ? installerSuffixes.map((suffix) => [suffix, suffix])
    : [
        ["darwin-aarch64.dmg", "aarch64.dmg"],
        ["darwin-x86_64.dmg", "x64.dmg"],
        ["windows-x86_64.exe", "x64-setup.exe"],
        ["linux-x86_64.AppImage", "amd64.AppImage"],
      ];
}

// Keep aliases outside release-installers: manifest and updater publication
// must continue to see only the original versioned build artifacts.
export async function prepareAliases(
  directory,
  output,
  tag,
  policy = "candidate",
) {
  const { version } = releaseVersion(tag);
  const source = resolve(directory);
  const destination = resolve(output);
  assert(
    destination !== source && !destination.startsWith(source + sep),
    "Alias output must be outside the installer directory",
  );
  const files = await filesUnder(directory);
  const copies = [];
  for (const [suffix, alias] of aliasSpecs(policy)) {
    const name = `SourceWeft_${version}_${suffix}`;
    const matches = files.filter((file) => basename(file) === name);
    assert.equal(matches.length, 1, `Expected exactly one ${name}`);
    assert((await stat(matches[0])).size > 0, `Empty installer: ${name}`);
    copies.push({
      source: matches[0],
      destination: join(output, `SourceWeft_${alias}`),
    });
  }
  await mkdir(output, { recursive: true });
  for (const copy of copies) await copyFile(copy.source, copy.destination);
  return copies;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await prepareAliases(
    "release-installers",
    "release-download-aliases",
    publicationTag(),
    process.env.DESKTOP_PUBLICATION_POLICY,
  );
}
