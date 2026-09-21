import { expect, test } from "vitest";
import {
  resolveUpdateTarget,
  summarizeVersionChangelog,
} from "./skill-version-update";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import messages from "../../../../messages/en.json";

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardSkillsMarket",
}) as unknown as ReturnType<typeof useTranslations>;

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

const changelog = {
  added: ["scripts/run.sh"],
  removed: ["old.md"],
  modified: ["SKILL.md"],
  newScripts: ["scripts/run.sh"],
  newFlags: [] as string[],
  compareUrl: `https://github.com/acme/skills/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
};

test("an update is summed up as files, new scripts and new flags, with GitHub's comparison", () => {
  expect(
    summarizeVersionChangelog(changelog, t),
  ).toEqual({
    summary: "3 files, 1 new script",
    compareUrl: changelog.compareUrl,
    escalates: true,
  });
  expect(
    summarizeVersionChangelog(
      {
        ...changelog,
        added: [],
        removed: [],
        modified: [],
        newScripts: [],
        newFlags: ["egress:fetch", "tool:sensitive"],
      },
      t,
    ).summary,
  ).toBe("no file changes, 2 new scan flags");
});

test("only a github.com https link is offered for the comparison", () => {
  for (const compareUrl of [
    null,
    "javascript:alert(1)",
    "http://github.com/a/b/compare/x...y",
    "https://evil.example/compare",
  ]) {
    expect(
      summarizeVersionChangelog(
        { ...changelog, compareUrl },
        t,
      ).compareUrl,
    ).toBeNull();
  }
});
