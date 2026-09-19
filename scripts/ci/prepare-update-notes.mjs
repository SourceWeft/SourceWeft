import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { releaseVersion } from "./verify-release-config.mjs";
const { version } = releaseVersion(process.env.GITHUB_REF_NAME);
const entry = JSON.parse(
  await readFile(`apps/web/content/changelog/v${version}.json`, "utf8"),
);
assert.equal(entry.tag, `v${version}`);
assert(
  Array.isArray(entry.items) &&
    entry.items.every((item) => typeof item === "string"),
);
assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.releasedAt));
await mkdir("output/updates", { recursive: true });
await writeFile(
  "output/updates/notes.txt",
  [entry.title, entry.summary, ...entry.items.map((item) => `• ${item}`)].join(
    "\n\n",
  ),
);
await appendFile(
  process.env.GITHUB_ENV,
  `UPDATE_NOTES_FILE=output/updates/notes.txt\nUPDATE_PUB_DATE=${entry.releasedAt}T00:00:00Z\n`,
);
