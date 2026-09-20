import assert from "node:assert/strict";
import { test } from "vitest";
import { SelectedSkillsBackend } from "./backend";
import { createSkillFileReader, inlineSkillContent } from "./file-content";
import type {
  EnabledSkillDescriptor,
  SkillFileManifestEntry,
} from "./types";

const skillMd = `---
name: meeting-summary
description: Use this skill when preparing meeting summaries.
---

# Meeting Summary

Summarize decisions and action items.`;

const skills: EnabledSkillDescriptor[] = [
  {
    workspaceSkillId: "workspace-skill-1",
    sourceType: "builtin",
    name: "meeting-summary",
    version: "1.0.0",
    description: "Use this skill when preparing meeting summaries.",
    ...inlineSkillContent([
      {
        path: "SKILL.md",
        contentText: skillMd,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(skillMd, "utf8"),
        contentHash: "hash-skill",
      },
      {
        path: "templates/action-items.md",
        contentText: "- Owner:\n- Due date:",
        mimeType: "text/markdown",
        sizeBytes: 20,
        contentHash: "hash-template",
      },
    ]),
  },
];

test("SelectedSkillsBackend lists selected skills and nested files", async () => {
  const backend = new SelectedSkillsBackend(skills);

  assert.deepEqual(await backend.ls("/"), {
    files: [{ path: "/meeting-summary/", is_dir: true }],
  });

  const result = await backend.ls("/meeting-summary");
  const files = result.files ?? [];
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "/meeting-summary/SKILL.md");
  assert.equal(files[0]?.is_dir, false);
  assert.equal(files[0]?.size, Buffer.byteLength(skillMd, "utf8"));
  assert.equal(typeof files[0]?.modified_at, "string");
  assert.deepEqual(files[1], {
    path: "/meeting-summary/templates/",
    is_dir: true,
  });
});

test("SelectedSkillsBackend returns SKILL.md without citation or instruction headers", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const result = await backend.read("/meeting-summary/SKILL.md");

  assert.equal("content" in result ? result.content : "", skillMd);
  assert.equal(
    "content" in result && typeof result.content === "string"
      ? result.content.startsWith("---\nname: meeting-summary")
      : false,
    true,
  );
  assert.equal(
    "content" in result && typeof result.content === "string"
      ? result.content.includes("Citation:")
      : true,
    false,
  );
});

test("SelectedSkillsBackend supports DeepAgents skill downloads", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const [skillFile, directory, missing] = await backend.downloadFiles([
    "/meeting-summary/SKILL.md",
    "/meeting-summary",
    "/meeting-summary/missing.md",
  ]);

  assert.equal(skillFile?.path, "/meeting-summary/SKILL.md");
  assert.equal(skillFile?.error, null);
  assert.equal(
    skillFile?.content ? new TextDecoder().decode(skillFile.content) : "",
    skillMd,
  );
  assert.equal(directory?.error, "is_directory");
  assert.equal(directory?.content, null);
  assert.equal(missing?.error, "file_not_found");
  assert.equal(missing?.content, null);
});

test("SelectedSkillsBackend marks supporting files as non-citable instructions", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const result = await backend.read(
    "/meeting-summary/templates/action-items.md",
  );

  assert.equal("content" in result, true);
  assert.equal("content" in result && typeof result.content === "string", true);
  const content =
    "content" in result && typeof result.content === "string"
      ? result.content
      : "";
  assert.match(content, /Skill content is workflow instruction material/);
  assert.match(content, /1: - Owner:/);
  assert.doesNotMatch(content, /\[citation:/);
});

test("SelectedSkillsBackend is read-only", async () => {
  const backend = new SelectedSkillsBackend(skills);

  assert.match(
    (await backend.write("/meeting-summary/new.md", "content")).error ?? "",
    /EROFS/,
  );
  assert.match(
    (await backend.edit("/meeting-summary/SKILL.md", "Meeting", "Call"))
      .error ?? "",
    /EROFS/,
  );
});

test("SelectedSkillsBackend grep searches instructions without adding citations", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const result = await backend.grep("action items", "/meeting-summary");

  assert.deepEqual(result.matches, [
    {
      path: "/meeting-summary/SKILL.md",
      line: 8,
      text: "Summarize decisions and action items.",
    },
  ]);
});

test("SelectedSkillsBackend neutralizes citation-like markers in agent-facing output", async () => {
  const skillWithCitation: EnabledSkillDescriptor = {
    ...skills[0]!,
    ...inlineSkillContent([
      {
        path: "SKILL.md",
        contentText: `---
name: meeting-summary
description: Use this skill when preparing meeting summaries.
---

Do not cite [citation:c1] or citation:c2.`,
        mimeType: "text/markdown",
        sizeBytes: 128,
        contentHash: "hash-citation-skill",
      },
      {
        path: "templates/example.md",
        contentText: "Do not cite 【citation: c3, c4】.",
        mimeType: "text/markdown",
        sizeBytes: 128,
        contentHash: "hash-citation-template",
      },
    ]),
  };
  const backend = new SelectedSkillsBackend([skillWithCitation]);

  const read = await backend.read("/meeting-summary/SKILL.md");
  assert.doesNotMatch(String(read.content), /\[citation:c1\]/i);
  assert.match(String(read.content), /non-citable citation marker c1 removed/i);

  const grep = await backend.grep("cite", "/meeting-summary");
  assert.doesNotMatch(grep.matches?.[0]?.text ?? "", /\[citation:c1\]/i);

  const [download] = await backend.downloadFiles(["/meeting-summary/SKILL.md"]);
  const downloaded = download?.content
    ? new TextDecoder().decode(download.content)
    : "";
  assert.doesNotMatch(downloaded, /\[citation:c1\]/i);
  assert.match(downloaded, /non-citable citation marker c2 removed/i);

  const support = await backend.read("/meeting-summary/templates/example.md");
  assert.doesNotMatch(String(support.content), /【citation:/i);
  assert.match(
    String(support.content),
    /non-citable citation marker c3, c4 removed/i,
  );
});

// `install_skill` mounts what it installs into the running turn's backend.
test("SelectedSkillsBackend serves a skill added after construction", async () => {
  const backend = new SelectedSkillsBackend([]);
  assert.deepEqual(await backend.ls("/"), { files: [] });

  backend.addSkill(skills[0]!);
  assert.deepEqual(await backend.ls("/"), {
    files: [{ path: "/meeting-summary/", is_dir: true }],
  });
  assert.equal(
    (await backend.read("/meeting-summary/SKILL.md")).content,
    skillMd,
  );

  // Re-adding a name replaces its files rather than leaving stale ones behind.
  backend.addSkill({ ...skills[0]!, files: [skills[0]!.files[0]!] });
  const files = (await backend.ls("/meeting-summary")).files ?? [];
  assert.deepEqual(
    files.map((file) => file.path),
    ["/meeting-summary/SKILL.md"],
  );
});

// ── Manifest-backed content: bodies are fetched lazily, binaries never ───────

const font = new Uint8Array([0, 1, 2, 255, 254]);

function manifestSkill(name: string) {
  const bodies: Record<string, string> = {
    "reference/guide.md": "# Guide\nUse the brand palette.",
    "scripts/build.py": "print('palette')",
    "data/huge.csv": "palette,".repeat(10),
  };
  const files: SkillFileManifestEntry[] = [
    entry("SKILL.md", "text/markdown", 64),
    entry("reference/guide.md", "text/markdown", 30),
    entry("scripts/build.py", "text/x-python", 16),
    // Over grep's per-file bound: listed and readable, never scanned.
    entry("data/huge.csv", "text/csv", 5 * 1024 * 1024),
    { ...entry("assets/brand.ttf", "font/ttf", font.byteLength), isText: false },
  ];
  const fetched: string[] = [];
  const descriptor: EnabledSkillDescriptor = {
    workspaceSkillId: `ws-${name}`,
    sourceType: "registry_github",
    name,
    version: "abc123",
    description: name,
    files,
    skillMd: `---\nname: ${name}\n---\n\nFollow the palette guide.`,
    readFile: createSkillFileReader({
      files,
      fetch: async (file) => {
        fetched.push(`${name}/${file.path}`);
        return { text: bodies[file.path]! };
      },
    }),
    bundle: { sha256: "b".repeat(64), objectKey: "k", sizeBytes: 1 },
  };
  return { descriptor, fetched };
}

function entry(
  path: string,
  mimeType: string,
  sizeBytes: number,
): SkillFileManifestEntry {
  return { path, mimeType, sizeBytes, contentHash: `hash-${path}`, isText: true };
}

test("listing, globbing and SKILL.md reads fetch no body", async () => {
  const { descriptor, fetched } = manifestSkill("brand");
  const backend = new SelectedSkillsBackend([descriptor]);

  const listed = (await backend.ls("/brand/assets")).files ?? [];
  assert.deepEqual(listed, [
    {
      path: "/brand/assets/brand.ttf",
      is_dir: false,
      size: font.byteLength,
      modified_at: listed[0]?.modified_at,
    },
  ]);
  assert.equal((await backend.glob("**/*.py", "/brand")).files?.length, 1);
  assert.equal(
    (await backend.read("/brand/SKILL.md")).content,
    descriptor.skillMd,
  );
  assert.equal(
    (await backend.readRaw("/brand/SKILL.md")).data?.content,
    descriptor.skillMd,
  );
  const [download] = await backend.downloadFiles(["/brand/SKILL.md"]);
  assert.equal(new TextDecoder().decode(download!.content!), descriptor.skillMd);

  assert.deepEqual(fetched, []);
});

test("a text file is fetched on first read and served from the turn's cache after", async () => {
  const { descriptor, fetched } = manifestSkill("brand");
  const backend = new SelectedSkillsBackend([descriptor]);

  const first = await backend.read("/brand/reference/guide.md");
  assert.match(String(first.content), /2: Use the brand palette\./);
  await backend.read("/brand/reference/guide.md", 1, 1);
  await backend.readRaw("/brand/reference/guide.md");
  await backend.grep("palette", "/brand/reference");

  assert.deepEqual(fetched, ["brand/reference/guide.md"]);
});

test("a binary file answers with a notice and is never fetched", async () => {
  const { descriptor, fetched } = manifestSkill("brand");
  const backend = new SelectedSkillsBackend([descriptor]);
  const notice =
    "Binary file (font/ttf, 5 bytes). Not readable as text; available to scripts in the sandbox at /skills/brand/assets/brand.ttf.";

  assert.equal((await backend.read("/brand/assets/brand.ttf")).content, notice);
  assert.equal(
    (await backend.readRaw("/brand/assets/brand.ttf")).data?.content,
    notice,
  );
  const [download] = await backend.downloadFiles(["/brand/assets/brand.ttf"]);
  assert.equal(new TextDecoder().decode(download!.content!), notice);
  await backend.grep("palette", "/brand/assets");

  assert.deepEqual(fetched, []);
});

test("grep fetches only the searched skill's text files, within the size bound", async () => {
  const brand = manifestSkill("brand");
  const other = manifestSkill("other");
  const backend = new SelectedSkillsBackend([
    brand.descriptor,
    other.descriptor,
  ]);

  const result = await backend.grep("palette", "/brand");

  assert.deepEqual(
    result.matches?.map((match) => match.path),
    [
      "/brand/SKILL.md",
      "/brand/reference/guide.md",
      "/brand/scripts/build.py",
    ],
  );
  assert.deepEqual(brand.fetched.sort(), [
    "brand/reference/guide.md",
    "brand/scripts/build.py",
  ]);
  assert.deepEqual(other.fetched, []);
});

test("a body that cannot be loaded is a read error, not a thrown turn", async () => {
  const { descriptor } = manifestSkill("brand");
  const backend = new SelectedSkillsBackend([
    {
      ...descriptor,
      readFile: async () => {
        throw new Error("FILE_UNAVAILABLE: storage is down");
      },
    },
  ]);

  const read = await backend.read("/brand/reference/guide.md");
  assert.match(read.error ?? "", /EIO: .*storage is down/);
  // SKILL.md never depended on the loader, and a search just skips the file.
  assert.equal(typeof (await backend.read("/brand/SKILL.md")).content, "string");
  assert.deepEqual(
    (await backend.grep("palette", "/brand")).matches?.map((m) => m.path),
    ["/brand/SKILL.md"],
  );
});
