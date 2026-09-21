import { expect, test } from "vitest";
import { resolveUpdateTarget } from "./skill-version-update";

const versions = [
  { id: "v3", isCurrent: false, status: "draft" },
  { id: "v2", isCurrent: true, status: "published" },
  { id: "v1", isCurrent: false, status: "published" },
];

test("nothing installed means nothing to update", () => {
  expect(resolveUpdateTarget({ installedVersionId: null, versions })).toBeNull();
  expect(
    resolveUpdateTarget({ installedVersionId: undefined, currentVersionId: "v2" }),
  ).toBeNull();
});

test("an install behind the published current version updates to it", () => {
  expect(resolveUpdateTarget({ installedVersionId: "v1", versions })).toBe("v2");
  expect(resolveUpdateTarget({ installedVersionId: "v2", versions })).toBeNull();
});

test("the caller's current version wins over the paged list", () => {
  // The list is paged by age: the current version may not be on this page.
  expect(
    resolveUpdateTarget({
      installedVersionId: "v1",
      currentVersionId: "v0",
      versions: [{ id: "v1", isCurrent: false, status: "published" }],
    }),
  ).toBe("v0");
  expect(
    resolveUpdateTarget({ installedVersionId: "v1", currentVersionId: "v1", versions }),
  ).toBeNull();
});

test("a current version still under review is not an update", () => {
  expect(
    resolveUpdateTarget({
      installedVersionId: "v1",
      versions: [
        { id: "v2", isCurrent: true, status: "draft" },
        { id: "v1", isCurrent: false, status: "published" },
      ],
    }),
  ).toBeNull();
});
