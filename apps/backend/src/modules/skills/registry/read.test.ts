import assert from "node:assert/strict";
import { strToU8 } from "fflate";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { zipball } from "../../../test/zip-fixture";

vi.mock("../../sources/storage", () => ({}));

type GitHubZip = typeof import("../../market/parser/github-zip");
type SkillStorage = typeof import("../storage");
// Loosely typed on purpose: the fakes below return only what the read stage
// looks at, as the per-file mock factories they replace did.
type ZipOverrides = Partial<
  Record<
    | "resolvePinnedGitHubSource"
    | "downloadRepoZip"
    | "listZipEntries"
    | "readZipEntries",
    (...args: never[]) => unknown
  >
>;

/**
 * `vi.mock` is file-scoped, so the describes below that need a faked GitHub
 * reader or shrunk storage limits share one mock each and set its behaviour
 * here. `null` means the real module: the mocks fall back to the actual
 * implementation, so the describes that do not set state see real behaviour.
 */
const state = vi.hoisted(() => ({
  zip: null as null | ZipOverrides,
  limits: null as null | Record<
    keyof SkillStorage["SKILL_STORAGE_LIMITS"],
    number
  >,
}));

vi.mock("../../market/parser/github-zip", async (original) => {
  const actual = await original<GitHubZip>();
  const delegate =
    <K extends keyof ZipOverrides>(name: K) =>
    (...args: unknown[]) =>
      ((state.zip?.[name] ?? actual[name]) as (...args: unknown[]) => unknown)(
        ...args,
      );
  return {
    ...actual,
    resolvePinnedGitHubSource: delegate("resolvePinnedGitHubSource"),
    downloadRepoZip: delegate("downloadRepoZip"),
    listZipEntries: delegate("listZipEntries"),
    readZipEntries: delegate("readZipEntries"),
  };
});

vi.mock("../storage", async (original) => {
  const actual = await original<SkillStorage>();
  return {
    ...actual,
    get SKILL_STORAGE_LIMITS() {
      return state.limits ?? actual.SKILL_STORAGE_LIMITS;
    },
  };
});

import { GitHubArchiveError } from "../../market/parser/github-zip";
import { RegistrySubmissionError } from "./errors";
import { extractRegistryLogo } from "./logo";
import {
  discoverSkillDirectories,
  readRegistrySkillsFromArchive,
  readRegistrySkillsFromGitHub,
} from "./read";
import { SKILL_STORAGE_LIMITS } from "../storage";

afterEach(() => {
  state.zip = null;
  state.limits = null;
});

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
   * (`read-bundle` below covers the behaviour around the limits with small ones.)
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

describe("read-source", () => {
  /**
   * What the read stage takes from — and how it reports failures of — the shared
   * GitHub reader. The archive itself is faked; discovery is covered above.
   */
  const github = {
    resolve: vi.fn(),
    download: vi.fn(),
  };

  const pinned = {
    owner: "acme",
    repo: "skills",
    subpath: "",
    commitSha: "a".repeat(40),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.zip = {
      resolvePinnedGitHubSource: github.resolve,
      downloadRepoZip: github.download,
      listZipEntries: vi.fn(async () => [
        { path: "SKILL.md", declaredSize: 40 },
      ]),
      readZipEntries: vi.fn(
        async () =>
          new Map([
            [
              "SKILL.md",
              Buffer.from("---\nname: writer\ndescription: W\n---\n"),
            ],
          ]),
      ),
    };
    github.download.mockResolvedValue(Buffer.alloc(0));
  });

  test("the pinned commit's date is passed on for version ordering", async () => {
    github.resolve.mockResolvedValue({
      ...pinned,
      committedAt: "2026-02-01T10:00:00.000Z",
    });
    const read = await readRegistrySkillsFromGitHub("acme/skills");
    assert.equal(read.committedAt, "2026-02-01T10:00:00.000Z");
  });

  test("a commit whose date cannot be read is refused before anything is downloaded", async () => {
    // Versions are ordered by commit age; an undated one cannot be placed, and
    // inventing a date would silently decide which version users get.
    for (const committedAt of [undefined, "not-a-date"]) {
      github.resolve.mockResolvedValue({ ...pinned, committedAt });
      await assert.rejects(
        readRegistrySkillsFromGitHub("acme/skills"),
        (error) =>
          error instanceof RegistrySubmissionError &&
          error.code === "REGISTRY_SUBMISSION_UNDATED",
      );
    }
    assert.equal(github.download.mock.calls.length, 0);
  });

  test("a GitHub timeout is a submission error, whichever request stalled", async () => {
    const timeout = new GitHubArchiveError("ARCHIVE_TIMEOUT", "too slow");
    const isMapped = (error: unknown) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_TIMEOUT" &&
      error.message === "too slow";

    github.resolve.mockRejectedValue(timeout);
    await assert.rejects(readRegistrySkillsFromGitHub("acme/skills"), isMapped);

    github.resolve.mockResolvedValue({
      ...pinned,
      committedAt: "2026-02-01T10:00:00.000Z",
    });
    github.download.mockRejectedValue(timeout);
    await assert.rejects(readRegistrySkillsFromGitHub("acme/skills"), isMapped);
  });
});

describe("read-logo", () => {
  const archive = { files: new Map<string, Buffer>() };

  beforeEach(() => {
    state.zip = {
      resolvePinnedGitHubSource: vi.fn(async () => ({
        owner: "acme",
        repo: "skills",
        subpath: "",
        commitSha: "a".repeat(40),
        committedAt: "2026-02-01T10:00:00.000Z",
      })),
      downloadRepoZip: vi.fn(async () => Buffer.alloc(0)),
      listZipEntries: vi.fn(async () =>
        [...archive.files].map(([path, bytes]) => ({
          path,
          declaredSize: bytes.byteLength,
        })),
      ),
      readZipEntries: vi.fn(
        async (_zip, wanted: (path: string) => boolean) =>
          new Map([...archive.files].filter(([path]) => wanted(path))),
      ),
    };
  });

  test("a binary logo is read as a bundle file of its own skill, and is what the logo is made from", async () => {
    const png = await sharp({
      create: { width: 12, height: 12, channels: 4, background: "blue" },
    })
      .png()
      .toBuffer();
    archive.files = new Map([
      [
        "skills/writer/SKILL.md",
        Buffer.from("---\nname: writer\ndescription: Writer\n---\nBody"),
      ],
      ["skills/writer/assets/logo.png", png],
      [
        "skills/editor/SKILL.md",
        Buffer.from("---\nname: editor\ndescription: Editor\n---\nBody"),
      ],
    ]);
    const read = await readRegistrySkillsFromGitHub(
      "https://github.com/acme/skills",
    );
    const writer = read.skills.find((skill) => skill.dirName === "writer")!;
    const editor = read.skills.find((skill) => skill.dirName === "editor")!;
    expect(writer.files.map((file) => [file.bundlePath, file.isText])).toEqual([
      ["assets/logo.png", false],
      ["SKILL.md", true],
    ]);
    expect(Buffer.from(writer.files[0]!.bytes)).toEqual(png);
    expect(writer.files[0]!.mimeType).toBe("image/png");
    expect(editor.files.map((file) => file.bundlePath)).toEqual(["SKILL.md"]);
    expect((await extractRegistryLogo(writer)).logo?.path).toBe(
      "assets/logo.png",
    );
    expect((await extractRegistryLogo(editor)).logo).toBeUndefined();
  });
});

describe("read-bundle", () => {
  /**
   * What the read stage makes of a real zipball: every bundle file is carried as
   * bytes — binary ones included — and a skill over a storage limit is refused
   * whole. The limits are shrunk so the fixtures stay a few KiB; the code under
   * test reads them from `SKILL_STORAGE_LIMITS` either way.
   */
  const LIMITS = {
    maxFiles: 4,
    maxFileBytes: 1024,
    maxBundleBytes: 2048,
  };

  // Lets one test make the archive under-declare its sizes, as a hostile one can.
  const lie = { declaredSize: null as number | null };

  const source = {
    owner: "acme",
    repo: "skills",
    subpath: "",
    repoUrl: "https://github.com/acme/skills",
    sourceUrl: "https://github.com/acme/skills",
    commitSha: "a".repeat(40),
    committedAt: "2026-02-01T10:00:00.000Z",
  };

  const SKILL_MD = "---\nname: poster\ndescription: Posters\n---\nBody\n";
  // Not valid UTF-8, so neither can be carried as text.
  const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x00]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const tooLarge = (error: unknown) =>
    error instanceof RegistrySubmissionError &&
    error.code === "REGISTRY_SUBMISSION_TOO_LARGE";

  beforeEach(async () => {
    const actual = await vi.importActual<GitHubZip>(
      "../../market/parser/github-zip",
    );
    state.limits = LIMITS;
    state.zip = {
      listZipEntries: async (zip: Buffer) =>
        (await actual.listZipEntries(zip)).map((entry) => ({
          ...entry,
          declaredSize: lie.declaredSize ?? entry.declaredSize,
        })),
    };
    lie.declaredSize = null;
  });

  test("binary files are part of the bundle, byte for byte, next to the text", async () => {
    const read = await readRegistrySkillsFromArchive(
      zipball({
        "skills/poster/SKILL.md": SKILL_MD,
        "skills/poster/fonts/Inter.ttf": TTF,
        "skills/poster/assets/cover.png": PNG,
      }),
      source,
    );
    const [skill] = read.skills;
    assert.equal(skill?.rejection, undefined);
    assert.deepEqual(
      skill?.files.map((file) => [file.bundlePath, file.isText, file.mimeType]),
      [
        ["assets/cover.png", false, "image/png"],
        ["fonts/Inter.ttf", false, "font/ttf"],
        ["SKILL.md", true, "text/markdown"],
      ],
    );
    const font = skill!.files.find((file) => file.bundlePath.endsWith(".ttf"))!;
    assert.deepEqual(new Uint8Array(font.bytes), TTF);
    assert.equal(font.sizeBytes, TTF.byteLength);
    assert.equal(font.contentText, null);
    const skillMd = skill!.files.find(
      (file) => file.bundlePath === "SKILL.md",
    )!;
    assert.equal(skillMd.contentText, SKILL_MD);
    assert.equal(Buffer.from(skillMd.bytes).toString("utf8"), SKILL_MD);
    assert.equal(read.committedAt, source.committedAt);
  });

  test("a skill with too many files is refused, not truncated", async () => {
    const files: Record<string, string> = { "SKILL.md": SKILL_MD };
    for (let index = 0; index < LIMITS.maxFiles; index += 1) {
      files[`references/${index}.md`] = "note";
    }
    const read = await readRegistrySkillsFromArchive(zipball(files), source);
    assert.ok(tooLarge(read.skills[0]?.rejection));
    assert.match(read.skills[0]!.rejection!.message, /5 files.*4-file limit/);
    assert.deepEqual(read.skills[0]?.files, []);
  });

  test("a skill with one file over the per-file limit is refused", async () => {
    const read = await readRegistrySkillsFromArchive(
      zipball({
        "SKILL.md": SKILL_MD,
        "assets/huge.bin": new Uint8Array(LIMITS.maxFileBytes + 1),
      }),
      source,
    );
    assert.ok(tooLarge(read.skills[0]?.rejection));
    assert.match(read.skills[0]!.rejection!.message, /assets\/huge\.bin/);
    assert.deepEqual(read.skills[0]?.files, []);
  });

  test("a skill whose files add up past the bundle limit is refused", async () => {
    const read = await readRegistrySkillsFromArchive(
      zipball({
        "SKILL.md": SKILL_MD,
        "assets/a.bin": new Uint8Array(LIMITS.maxFileBytes),
        "assets/b.bin": new Uint8Array(LIMITS.maxFileBytes),
      }),
      source,
    );
    assert.ok(tooLarge(read.skills[0]?.rejection));
    assert.match(read.skills[0]!.rejection!.message, /in total/);
  });

  test("one oversized skill does not cost the repository its other skills", async () => {
    const read = await readRegistrySkillsFromArchive(
      zipball({
        "skills/big/SKILL.md": SKILL_MD,
        "skills/big/huge.bin": new Uint8Array(LIMITS.maxFileBytes + 1),
        "skills/small/SKILL.md": SKILL_MD,
        "skills/small/fonts/Inter.ttf": TTF,
      }),
      source,
    );
    const byDir = new Map(read.skills.map((skill) => [skill.dirName, skill]));
    assert.ok(tooLarge(byDir.get("big")?.rejection));
    assert.equal(byDir.get("small")?.rejection, undefined);
    assert.deepEqual(
      byDir.get("small")?.files.map((file) => file.bundlePath),
      ["fonts/Inter.ttf", "SKILL.md"],
    );
  });

  test("a nested skill's files count against it, not the skill above", async () => {
    const files: Record<string, string> = {
      "SKILL.md": SKILL_MD,
      "skills/inner/SKILL.md": SKILL_MD,
    };
    for (let index = 0; index < LIMITS.maxFiles - 1; index += 1) {
      files[`skills/inner/references/${index}.md`] = "note";
    }
    const read = await readRegistrySkillsFromArchive(zipball(files), source);
    const byDir = new Map(
      read.skills.map((skill) => [skill.repoSubpath, skill]),
    );
    assert.deepEqual(
      byDir.get("")?.files.map((file) => file.bundlePath),
      ["SKILL.md"],
    );
    assert.equal(byDir.get("skills/inner")?.files.length, LIMITS.maxFiles);
  });

  test("an archive that under-declares its sizes is caught on the actual bytes", async () => {
    lie.declaredSize = 1;
    const read = await readRegistrySkillsFromArchive(
      zipball({
        "SKILL.md": SKILL_MD,
        "assets/a.bin": new Uint8Array(LIMITS.maxFileBytes),
        "assets/b.bin": new Uint8Array(LIMITS.maxFileBytes),
      }),
      source,
    );
    assert.ok(tooLarge(read.skills[0]?.rejection));
    assert.deepEqual(read.skills[0]?.files, []);
  });

  test("a source without a commit date is refused", async () => {
    await assert.rejects(
      readRegistrySkillsFromArchive(zipball({ "SKILL.md": SKILL_MD }), {
        ...source,
        committedAt: undefined,
      }),
      (error) =>
        error instanceof RegistrySubmissionError &&
        error.code === "REGISTRY_SUBMISSION_UNDATED",
    );
  });
});
