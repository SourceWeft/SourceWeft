import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertNoRegistryFileWrite,
  assertRegistryStorageInvariant,
} from "./repository";

// Hard invariant 1 (skill-registry-index.md §0): storageType='pointer' ⇔
// sourceType='registry_github'. Verify the biconditional in BOTH directions —
// the matched pairs pass, and every cross pairing throws.

test("invariant 1: the two matched pairings are accepted", () => {
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("registry_github", "pointer"),
  );
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("workspace_custom", "db_text"),
  );
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("team_custom", "db_text"),
  );
  assert.doesNotThrow(() =>
    assertRegistryStorageInvariant("builtin", "repo_builtin"),
  );
});

test("invariant 1: registry_github with non-pointer storage throws", () => {
  // registry_github ⇒ pointer (forward direction).
  assert.throws(
    () => assertRegistryStorageInvariant("registry_github", "db_text"),
    /pointer ⇔ registry_github/,
  );
  assert.throws(
    () => assertRegistryStorageInvariant("registry_github", "repo_builtin"),
    /pointer ⇔ registry_github/,
  );
});

test("invariant 1: pointer storage with a non-registry source throws", () => {
  // pointer ⇒ registry_github (reverse direction).
  for (const source of ["builtin", "workspace_custom", "team_custom"] as const) {
    assert.throws(
      () => assertRegistryStorageInvariant(source, "pointer"),
      /pointer ⇔ registry_github/,
      source,
    );
  }
});

// Hard invariant 2 (§0/§1): a pointer/registry_github version persists ZERO
// skill_version_files rows — the redistribution tripwire.

test("invariant 2: writing a file for a pointer version throws", () => {
  assert.throws(
    () => assertNoRegistryFileWrite("pointer"),
    /must not persist skill_version_files/,
  );
});

test("invariant 2: file writes for local storage types are allowed", () => {
  assert.doesNotThrow(() => assertNoRegistryFileWrite("db_text"));
  assert.doesNotThrow(() => assertNoRegistryFileWrite("repo_builtin"));
});
