import assert from "node:assert/strict";
import { strToU8 } from "fflate";
import { describe, test, vi } from "vitest";
import { zipball } from "../../../test/zip-fixture";

vi.mock("../../sources/storage", () => ({}));

import { RegistrySubmissionError } from "./errors";
import {
  discoverSkillDirectories,
  readRegistrySkillsFromArchive,
} from "./read";
import { SKILL_STORAGE_LIMITS } from "../storage";

test("finds a skill at the repo root", () => {
  assert.deepEqual(discoverSkillDirectories(["SKILL.md", "README.md"]), [""]);
});

test("finds skills one level under each container", () => {
  assert.deepEqual(
    discoverSkillDirectories([
      "skills/writer/SKILL.md",
      ".claude/skills/editor/SKILL.md",
      ".agents/skills/planner/SKILL.md",
    ]),
    [".agents/skills/planner", ".claude/skills/editor", "skills/writer"],
  );
});

test("finds skills nested arbitrarily deep under a container", () => {
  // Repos that ship more than a handful group them by topic. Requiring exactly
  // one level made a 90-skill repository discover zero and be rejected outright.
  assert.deepEqual(
    discoverSkillDirectories([
      "skills/0-strategy/planning-prework-pack/SKILL.md",
      "skills/1-brand-marketing/seo/brief-writer/SKILL.md",
    ]),
    [
      "skills/0-strategy/planning-prework-pack",
      "skills/1-brand-marketing/seo/brief-writer",
    ],
  );
});

test("ignores a SKILL.md that is sample content outside the containers", () => {
  assert.deepEqual(
    discoverSkillDirectories([
      "docs/examples/demo/SKILL.md",
      "templates/SKILL.md",
      "skills/real/SKILL.md",
    ]),
    ["skills/real"],
  );
});

test("a file merely ending in SKILL.md is not a skill", () => {
  assert.deepEqual(
    discoverSkillDirectories(["skills/writer/NOT-SKILL.md"]),
    [],
  );
});

test("a deep link scopes discovery to that subtree, container names aside", () => {
  // Scoping into `skills/1-brand-marketing/` strips the very `skills/` prefix
  // the container check looks for, so insisting on containers here made every
  // deep link find nothing. An explicit subpath IS the statement of where to
  // look — which is what makes it a usable escape hatch for a repo too large
  // to index whole.
  const paths = [
    "skills/0-strategy/planner/SKILL.md",
    "skills/1-brand-marketing/seo-brief-writer/SKILL.md",
    "skills/1-brand-marketing/content-fission/SKILL.md",
  ];
  assert.deepEqual(
    discoverSkillDirectories(paths, "skills/1-brand-marketing"),
    [
      "skills/1-brand-marketing/content-fission",
      "skills/1-brand-marketing/seo-brief-writer",
    ],
  );
});

test("a deep link straight at one skill yields exactly that skill", () => {
  assert.deepEqual(
    discoverSkillDirectories(
      ["skills/pdf/SKILL.md", "skills/docx/SKILL.md"],
      "skills/pdf",
    ),
    ["skills/pdf"],
  );
});

describe("read-limits", () => {
  /**
   * The REAL numbers: a skill is refused at exactly `SKILL_STORAGE_LIMITS`, the
   * limits the object store and the sandbox staging run under — and a file the
   * MCP market's 512 KiB reader default would have rejected is read.
   * (`read-bundle.test.ts` covers the behaviour around the limits with small ones.)
   */
  const MiB = 1024 * 1024;
  const source = {
    owner: "acme",
    repo: "skills",
    subpath: "",
    repoUrl: "https://github.com/acme/skills",
    sourceUrl: "https://github.com/acme/skills",
    commitSha: "a".repeat(40),
    committedAt: "2026-02-01T10:00:00.000Z",
  };
  const SKILL_MD = strToU8(
    "---\nname: poster\ndescription: Posters\n---\nBody\n",
  );

  async function rejectionOf(files: Record<string, Uint8Array>) {
    const read = await readRegistrySkillsFromArchive(
      zipball({ "SKILL.md": SKILL_MD, ...files }),
      source,
    );
    return read.skills[0]?.rejection;
  }

  const tooLarge = (error: unknown) =>
    error instanceof RegistrySubmissionError &&
    error.code === "REGISTRY_SUBMISSION_TOO_LARGE";

  test("the limits are the storage limits", () => {
    assert.deepEqual(SKILL_STORAGE_LIMITS, {
      maxFiles: 200,
      maxFileBytes: 10 * MiB,
      maxBundleBytes: 50 * MiB,
    });
  });

  test("200 files are a skill, 201 are not", async () => {
    const references = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `references/${index}.md`,
          strToU8("note"),
        ]),
      );
    assert.equal(await rejectionOf(references(199)), undefined);
    const rejection = await rejectionOf(references(200));
    assert.ok(tooLarge(rejection));
    assert.match(rejection!.message, /201 files.*200-file limit/);
  });

  test("a 10 MiB file is carried, one byte more is not", async () => {
    const read = await readRegistrySkillsFromArchive(
      zipball({
        "SKILL.md": SKILL_MD,
        "assets/video.bin": new Uint8Array(10 * MiB),
      }),
      source,
    );
    assert.equal(read.skills[0]?.rejection, undefined);
    assert.equal(
      read.skills[0]?.files.find(
        (file) => file.bundlePath === "assets/video.bin",
      )?.sizeBytes,
      10 * MiB,
    );

    const rejection = await rejectionOf({
      "assets/video.bin": new Uint8Array(10 * MiB + 1),
    });
    assert.ok(tooLarge(rejection));
    assert.match(rejection!.message, /assets\/video\.bin.*10 MiB limit/);
  });

  test("files adding up past 50 MiB are refused", async () => {
    const chunk = new Uint8Array(9 * MiB);
    const rejection = await rejectionOf(
      Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`assets/${index}.bin`, chunk]),
      ),
    );
    assert.ok(tooLarge(rejection));
    assert.match(rejection!.message, /in total.*50 MiB limit/);
  });

  test("skills that each fit but do not fit together are refused with a way forward", async () => {
    // Two 40 MiB skills: each under the 50 MiB per-skill limit, 80 MiB together.
    const heavy = (dir: string) =>
      Object.fromEntries([
        [
          `skills/${dir}/SKILL.md`,
          strToU8(`---\nname: ${dir}\ndescription: Heavy ${dir}\n---\nBody\n`),
        ],
        ...Array.from({ length: 4 }, (_, index) => [
          `skills/${dir}/assets/${index}.bin`,
          new Uint8Array(10 * MiB),
        ]),
      ]);
    await assert.rejects(
      readRegistrySkillsFromArchive(
        zipball({ ...heavy("one"), ...heavy("two") }),
        source,
      ),
      (error: unknown) => {
        assert.ok(tooLarge(error));
        assert.match((error as Error).message, /add up to 80 MiB/);
        assert.match((error as Error).message, /one at a time/);
        return true;
      },
    );

    // The way forward works: the same archive, deep-linked at one of them.
    const one = await readRegistrySkillsFromArchive(
      zipball({ ...heavy("one"), ...heavy("two") }),
      { ...source, subpath: "skills/one" },
    );
    assert.equal(one.skills.length, 1);
    assert.equal(one.skills[0]?.rejection, undefined);
  });
});
