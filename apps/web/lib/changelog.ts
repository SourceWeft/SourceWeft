import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ChangelogEntry } from "./changelog-entry";

// Entries live in the repo so a release and its notes move through the same
// review, and so CI can refuse a tag that has none.
const CHANGELOG_DIR = path.join(process.cwd(), "content", "changelog");

export function loadChangelogEntries(): ChangelogEntry[] {
  return readdirSync(CHANGELOG_DIR)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(
          readFileSync(path.join(CHANGELOG_DIR, name), "utf8"),
        ) as ChangelogEntry,
    )
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}
