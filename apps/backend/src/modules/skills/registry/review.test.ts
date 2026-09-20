import assert from "node:assert/strict";
import { test } from "vitest";
import { pickRevocationSuccessor } from "./review";

const OLDER = "2026-01-01T00:00:00.000Z";
const NEWER = "2026-02-01T00:00:00.000Z";
const at = (ms: number) => new Date(Date.UTC(2026, 5, 1) + ms);

function pick(
  candidates: Array<{ id: string; committedAt?: string; createdAt: Date }>,
) {
  return (
    pickRevocationSuccessor(
      candidates.map((candidate) => ({
        ...candidate,
        committedAt: candidate.committedAt,
      })),
    )?.id ?? null
  );
}

test("the successor of a revoked current version is the newest commit left", () => {
  // Commit order, not write order: the older commit was stored last.
  assert.equal(
    pick([
      { id: "newer", committedAt: NEWER, createdAt: at(0) },
      { id: "older", committedAt: OLDER, createdAt: at(10) },
    ]),
    "newer",
  );
  // Equal dates fall to the newer write, as they do on the way in.
  assert.equal(
    pick([
      { id: "first", committedAt: NEWER, createdAt: at(0) },
      { id: "second", committedAt: NEWER, createdAt: at(10) },
    ]),
    "second",
  );
});

test("a version with no commit date ranks below every dated one", () => {
  assert.equal(
    pick([
      { id: "legacy", createdAt: at(99) },
      { id: "older", committedAt: OLDER, createdAt: at(0) },
    ]),
    "older",
  );
  // An unparseable date is no date.
  assert.equal(
    pick([
      { id: "garbage", committedAt: "not-a-date", createdAt: at(99) },
      { id: "older", committedAt: OLDER, createdAt: at(0) },
    ]),
    "older",
  );
  // Undated versions have nothing else to compare: newest write first.
  assert.equal(
    pick([
      { id: "legacy-1", createdAt: at(0) },
      { id: "legacy-3", createdAt: at(20) },
      { id: "legacy-2", createdAt: at(10) },
    ]),
    "legacy-3",
  );
});

test("nothing published is left: there is no successor", () => {
  assert.equal(pick([]), null);
});
