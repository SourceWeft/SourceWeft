import assert from "node:assert/strict";
import { test } from "vitest";
import { assertRegistryStorageInvariant } from "./repository";

// Hard invariant (skill-registry-index.md §0): storageType='repo_builtin' ⇔
// sourceType='builtin'. Verify the biconditional in BOTH directions — the
// matched pairs pass, and every cross pairing throws.

test("the matched pairings are accepted", () => {
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("builtin", "repo_builtin"),
  );
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("workspace_custom", "db_text"),
  );
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("team_custom", "db_text"),
  );
  // Registry skills store their bundle exactly like custom skills do; they get
  // no storage type of their own.
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("registry_github", "db_text"),
  );
});

test("a builtin claiming db_text throws", () => {
  // builtin ⇒ repo_builtin (forward direction): a builtin's bodies ship on
  // disk, so rows would shadow the files we ship.
  assert.throws(
    () => assertRegistryStorageInvariant("builtin", "db_text"),
    /repo_builtin ⇔ builtin/,
  );
});

test("repo_builtin storage with a non-builtin source throws", () => {
  // repo_builtin ⇒ builtin (reverse direction): no other source may point at
  // files in this repo.
  for (const source of [
    "workspace_custom",
    "team_custom",
    "registry_github",
  ] as const) {
    assert.throws(
      () => assertRegistryStorageInvariant(source, "repo_builtin"),
      /repo_builtin ⇔ builtin/,
      source,
    );
  }
});
