import assert from "node:assert/strict";
import { test } from "vitest";
import { canUpgradeSupportingBundle } from "./bundle-projection";
import type { SkillManifestJson } from "@sourceweft/db";
const previous = {
  registry: { ingestion: { parserVersion: "1" } },
} as SkillManifestJson;
const next = {
  registry: {
    ingestion: {
      parserVersion: "2",
      diagnostics: [
        { code: "SUPPORTING_SKILL_DOCUMENT", file: "helper/SKILL.md" },
      ],
    },
  },
} as SkillManifestJson;
const old = [{ path: "SKILL.md", contentHash: "unchanged" }];
const added = [
  ...old,
  { path: "helper/SKILL.md", contentHash: "helper" },
  { path: "helper/run.py", contentHash: "script" },
];
test("a verified additive helper repair is eligible, other content changes are not", () => {
  const input = { previous, next, previousFiles: old, nextFiles: added };
  assert.equal(canUpgradeSupportingBundle(input), true);
  assert.equal(
    canUpgradeSupportingBundle({
      ...input,
      nextFiles: [{ ...old[0]!, contentHash: "changed" }, ...added.slice(1)],
    }),
    false,
  );
  assert.equal(
    canUpgradeSupportingBundle({ ...input, nextFiles: added.slice(1) }),
    false,
  );
  assert.equal(
    canUpgradeSupportingBundle({
      ...input,
      nextFiles: [...added, { path: "unrelated/file", contentHash: "new" }],
    }),
    false,
  );
  assert.equal(canUpgradeSupportingBundle({ ...input, nextFiles: old }), false);
  assert.equal(canUpgradeSupportingBundle({ ...input, previous: next }), false);
});
