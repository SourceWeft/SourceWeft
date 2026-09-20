import { beforeEach, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  reads: [] as Array<{ objectKey: string; maxBytes?: number }>,
}));
vi.mock("./storage", () => ({
  readSkillBlob: async (input: { objectKey: string; maxBytes?: number }) => {
    store.reads.push(input);
    const body = store.blobs.get(input.objectKey);
    if (!body) {
      throw new Error("FILE_UNAVAILABLE: Stored file has no body");
    }
    return body;
  },
}));

const { readSkillDocuments, readSkillVersionDocuments } = await import(
  "./documents"
);

beforeEach(() => {
  store.blobs.clear();
  store.reads = [];
});

test("prefers the bundle README without altering source bytes", () => {
  const files = [
    { path: "README.zh-CN.md", contentText: "中文" },
    { path: "readme.md", contentText: "lowercase" },
    { path: "README.md", contentText: "\n# Original\n" },
    { path: "SKILL.md", contentText: "---\nname: skill\n---\nBody" },
  ];
  expect(readSkillDocuments(files)).toEqual({
    readmeContent: "\n# Original\n",
    readmePath: "README.md",
    skillContent: files[3]!.contentText,
  });
  expect(readSkillDocuments([...files].reverse())).toEqual(
    readSkillDocuments(files),
  );
});

test("recognizes alternate names but never borrows a nested skill README", () => {
  expect(
    readSkillDocuments([{ path: "readme.md", contentText: "intro" }])
      .readmePath,
  ).toBe("readme.md");
  expect(
    readSkillDocuments([{ path: "README.zh-CN.md", contentText: "说明" }])
      .readmePath,
  ).toBe("README.zh-CN.md");
  expect(
    readSkillDocuments([
      { path: "references/README.md", contentText: "unrelated" },
      { path: "README.md", contentText: "  \n" },
    ]),
  ).toEqual({ readmeContent: null, readmePath: null, skillContent: null });
});

test("a skill-only bundle remains available for introduction display", () => {
  expect(
    readSkillDocuments([{ path: "SKILL.md", contentText: "# Skill" }]),
  ).toEqual({ readmeContent: null, readmePath: null, skillContent: "# Skill" });
});

function blobRow(path: string, body: string, mimeType = "text/markdown") {
  const objectKey = `blob:${path}`;
  store.blobs.set(objectKey, Buffer.from(body));
  return {
    path,
    mimeType,
    sizeBytes: Buffer.byteLength(body),
    objectKey,
    contentText: null,
  };
}

test("an object version's SKILL.md comes from skill_md and its README from one bounded blob read", async () => {
  const documents = await readSkillVersionDocuments({
    version: { skillMd: "# From the version row" },
    files: [
      blobRow("SKILL.md", "# From the blob — never read"),
      blobRow("README.zh-CN.md", "中文"),
      blobRow("README.md", "# Author introduction"),
      blobRow("references/README.md", "nested, unrelated"),
      blobRow("assets/brand.ttf", "bytes", "font/ttf"),
    ],
  });

  expect(documents).toEqual({
    skillContent: "# From the version row",
    readmePath: "README.md",
    readmeContent: "# Author introduction",
  });
  expect(store.reads).toEqual([
    { objectKey: "blob:README.md", maxBytes: 512 * 1024 },
  ]);
});

test("an oversized or blank README blob is passed over, and a missing one costs no read", async () => {
  const huge = { ...blobRow("README.md", "x"), sizeBytes: 600 * 1024 };
  expect(
    await readSkillVersionDocuments({
      version: { skillMd: "# Skill" },
      files: [huge, blobRow("readme.md", "  \n"), blobRow("README.fr.md", "Bonjour")],
    }),
  ).toEqual({
    skillContent: "# Skill",
    readmePath: "README.fr.md",
    readmeContent: "Bonjour",
  });
  expect(store.reads.map((read) => read.objectKey)).toEqual([
    "blob:readme.md",
    "blob:README.fr.md",
  ]);

  store.reads = [];
  expect(
    await readSkillVersionDocuments({
      version: { skillMd: "# Skill" },
      files: [blobRow("SKILL.md", "# Skill")],
    }),
  ).toEqual({ skillContent: "# Skill", readmePath: null, readmeContent: null });
  expect(store.reads).toEqual([]);
});

test("a db_text version's documents come straight off its manifest rows", async () => {
  const inline = (path: string, contentText: string | null) => ({
    path,
    mimeType: "text/markdown",
    sizeBytes: 1,
    objectKey: null,
    contentText,
  });
  expect(
    await readSkillVersionDocuments({
      version: { skillMd: null },
      files: [
        inline("SKILL.md", "# Custom"),
        inline("README.md", "about"),
        inline("reference/notes.md", null),
      ],
    }),
  ).toEqual({
    skillContent: "# Custom",
    readmePath: "README.md",
    readmeContent: "about",
  });
  expect(store.reads).toEqual([]);
});

test("a storage failure is an error, not a skill without documentation", async () => {
  const row = blobRow("README.md", "intro");
  store.blobs.delete(row.objectKey);
  await expect(
    readSkillVersionDocuments({ version: { skillMd: "# s" }, files: [row] }),
  ).rejects.toThrow("FILE_UNAVAILABLE");
});
