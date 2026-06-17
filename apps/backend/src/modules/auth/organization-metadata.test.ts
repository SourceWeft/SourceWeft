import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSourceweftOrganizationMetadata,
  isPersonalOrganizationMetadata,
  parseSourceweftOrganizationKind,
  withSourceweftOrganizationKind,
} from "./organization-metadata";

// ── createSourceweftOrganizationMetadata ────────────────────────────

test("createSourceweftOrganizationMetadata builds a personal metadata object", () => {
  const meta = createSourceweftOrganizationMetadata("personal");
  assert.deepEqual(meta, { sourceweft: { kind: "personal" } });
});

test("createSourceweftOrganizationMetadata builds a team metadata object", () => {
  const meta = createSourceweftOrganizationMetadata("team");
  assert.deepEqual(meta, { sourceweft: { kind: "team" } });
});

// ── parseSourceweftOrganizationKind ─────────────────────────────────

test("parseSourceweftOrganizationKind extracts 'personal' from a valid object", () => {
  assert.equal(
    parseSourceweftOrganizationKind({ sourceweft: { kind: "personal" } }),
    "personal",
  );
});

test("parseSourceweftOrganizationKind extracts 'team' from a valid object", () => {
  assert.equal(
    parseSourceweftOrganizationKind({ sourceweft: { kind: "team" } }),
    "team",
  );
});

test("parseSourceweftOrganizationKind returns null for missing sourceweft key", () => {
  assert.equal(
    parseSourceweftOrganizationKind({ other: "data" }),
    null,
  );
});

test("parseSourceweftOrganizationKind returns null for an unknown kind", () => {
  assert.equal(
    parseSourceweftOrganizationKind({ sourceweft: { kind: "enterprise" } }),
    null,
  );
});

test("parseSourceweftOrganizationKind handles JSON string input", () => {
  assert.equal(
    parseSourceweftOrganizationKind(
      JSON.stringify({ sourceweft: { kind: "personal" } }),
    ),
    "personal",
  );
});

test("parseSourceweftOrganizationKind handles double-encoded JSON string", () => {
  assert.equal(
    parseSourceweftOrganizationKind(
      JSON.stringify(JSON.stringify({ sourceweft: { kind: "team" } })),
    ),
    "team",
  );
});

test("parseSourceweftOrganizationKind returns null for empty string", () => {
  assert.equal(parseSourceweftOrganizationKind(""), null);
});

test("parseSourceweftOrganizationKind returns null for null", () => {
  assert.equal(parseSourceweftOrganizationKind(null), null);
});

test("parseSourceweftOrganizationKind returns null for undefined", () => {
  assert.equal(parseSourceweftOrganizationKind(undefined), null);
});

test("parseSourceweftOrganizationKind returns null for a non-JSON string", () => {
  assert.equal(parseSourceweftOrganizationKind("not-json"), null);
});

test("parseSourceweftOrganizationKind returns null for an array", () => {
  assert.equal(parseSourceweftOrganizationKind([1, 2, 3]), null);
});

// ── isPersonalOrganizationMetadata ──────────────────────────────────

test("isPersonalOrganizationMetadata returns true for personal metadata", () => {
  assert.equal(
    isPersonalOrganizationMetadata({ sourceweft: { kind: "personal" } }),
    true,
  );
});

test("isPersonalOrganizationMetadata returns false for team metadata", () => {
  assert.equal(
    isPersonalOrganizationMetadata({ sourceweft: { kind: "team" } }),
    false,
  );
});

test("isPersonalOrganizationMetadata returns false for empty metadata", () => {
  assert.equal(isPersonalOrganizationMetadata({}), false);
});

// ── withSourceweftOrganizationKind ──────────────────────────────────

test("withSourceweftOrganizationKind adds kind to empty metadata", () => {
  assert.deepEqual(withSourceweftOrganizationKind({}, "personal"), {
    sourceweft: { kind: "personal" },
  });
});

test("withSourceweftOrganizationKind preserves existing top-level keys", () => {
  const result = withSourceweftOrganizationKind(
    { plan: "pro", sourceweft: { other: 1 } },
    "team",
  );
  assert.equal(result.plan, "pro");
  assert.deepEqual(result.sourceweft, { other: 1, kind: "team" });
});

test("withSourceweftOrganizationKind overwrites an existing kind", () => {
  const result = withSourceweftOrganizationKind(
    { sourceweft: { kind: "personal" } },
    "team",
  );
  assert.deepEqual(result.sourceweft, { kind: "team" });
});

test("withSourceweftOrganizationKind handles null input", () => {
  assert.deepEqual(withSourceweftOrganizationKind(null, "personal"), {
    sourceweft: { kind: "personal" },
  });
});
