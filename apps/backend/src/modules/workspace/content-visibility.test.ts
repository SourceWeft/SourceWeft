import assert from "node:assert/strict";
import { test } from "vitest";
import { canViewContent, canViewThread } from "./content-visibility";

test("workspace content is visible to any member", () => {
  assert.equal(
    canViewContent("user-b", { visibility: "workspace", createdBy: "user-a" }),
    true,
  );
});

test("private content is visible only to its creator", () => {
  const row = { visibility: "private" as const, createdBy: "user-a" };
  assert.equal(canViewContent("user-a", row), true);
  assert.equal(canViewContent("user-b", row), false);
});

test("a private row with no creator is visible to nobody", () => {
  assert.equal(
    canViewContent("user-a", { visibility: "private", createdBy: null }),
    false,
  );
});

test("a public-linked thread stays visible to other members", () => {
  // public_link is an external-sharing flag, not an internal hide.
  assert.equal(
    canViewThread("user-b", { visibility: "public_link", createdBy: "user-a" }),
    true,
  );
});

test("a private thread is visible only to its author", () => {
  const row = { visibility: "private", createdBy: "user-a" };
  assert.equal(canViewThread("user-a", row), true);
  assert.equal(canViewThread("user-b", row), false);
});

test("a creator-less private thread is visible to nobody", () => {
  // Same fail-closed rule as canViewContent. Legacy pre-creator-tracking
  // threads were backfilled to workspace visibility (migration 0019), so a
  // null creator on a private row can only be a bug — hide, don't share.
  assert.equal(
    canViewThread("user-b", { visibility: "private", createdBy: null }),
    false,
  );
});
