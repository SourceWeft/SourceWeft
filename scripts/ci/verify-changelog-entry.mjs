import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { releaseVersion } from "./verify-release-config.mjs";

const tag = process.env.GITHUB_REF_NAME ?? "";
assert.ok(
  tag.startsWith("ci-package-v") || tag.startsWith("v"),
  "Expected a v* release tag or ci-package-v* verification tag",
);
// Repeat verification without moving an existing tag or writing a new entry.
const versionTag = tag.startsWith("ci-package-")
  ? tag.slice("ci-package-".length).replace(/--attempt\.[1-9]\d*$/, "")
  : tag;
const { version } = releaseVersion(versionTag);

const entryTag = `v${version}`;
const file = new URL(
  `../../apps/web/content/changelog/${entryTag}.json`,
  import.meta.url,
);

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch {
  assert.fail(
    `Missing apps/web/content/changelog/${entryTag}.json. Every release tag needs changelog notes.`,
  );
}

const entry = JSON.parse(raw);
assert.equal(entry.tag, entryTag, "Entry tag must match the release tag");
assert.match(
  entry.releasedAt ?? "",
  /^\d{4}-\d{2}-\d{2}$/,
  "releasedAt must be an ISO date",
);
assert.equal(entry.category, "Release", "category must be Release");
for (const field of ["title", "commit", "summary"]) {
  assert.ok(
    typeof entry[field] === "string" && entry[field].trim().length > 0,
    `${field} must be a non-empty string`,
  );
}
assert.ok(
  Array.isArray(entry.items) &&
    entry.items.length > 0 &&
    entry.items.every((item) => typeof item === "string" && item.trim()),
  "items must be a non-empty array of non-empty strings",
);
console.log(`Changelog entry ${entryTag} is present and complete.`);
