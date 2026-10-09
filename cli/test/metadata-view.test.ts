import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillFrontmatter, sha256 } from "@sourceweft/skill-format";
import { prepareInstalledFiles } from "../src/install/metadata-view";
const bytes = (value: string) => new TextEncoder().encode(value);
test("missing metadata becomes a standard local header and the original bytes stay available", () => {
  const raw = bytes("# Human title\n\nDo the work.\n");
  const result = prepareInstalledFiles(
    [
      { path: "SKILL.md", bytes: raw },
      { path: "script.py", bytes: bytes("print(1)") },
    ],
    "human-title",
    "Do the work.",
  );
  const installed = new TextDecoder().decode(
    result.files.find((f) => f.path === "SKILL.md")!.bytes,
  );
  assert.deepEqual(parseSkillFrontmatter(installed), {
    name: "human-title",
    description: "Do the work.",
  });
  assert.ok(installed.endsWith(new TextDecoder().decode(raw)));
  assert.deepEqual(
    result.files.find((f) => f.path === result.originalSkillMd)!.bytes,
    raw,
  );
  assert.equal(result.sourceFiles!["SKILL.md"], sha256(raw));
  assert.equal(
    result.files.find((f) => f.path === "script.py")!.bytes[0],
    "p".charCodeAt(0),
  );
});
test("only necessary loader fields change and permission declarations retain their values", () => {
  const raw = bytes(
    "<!-- exported -->\n---\nname: Human Title\ndescription: Useful\nallowed-tools: 'Read Bash(git:*)'\nmetadata:\n  label: yes\n---\nBody\n",
  );
  const result = prepareInstalledFiles(
    [{ path: "SKILL.md", bytes: raw }],
    "human-title",
    "Useful",
  );
  const parsed = parseSkillFrontmatter(
    new TextDecoder().decode(result.files[0]!.bytes),
  )!;
  assert.equal(parsed.name, "human-title");
  assert.equal(parsed["allowed-tools"], "Read Bash(git:*)");
  assert.deepEqual(parsed.metadata, { label: "yes" });
  assert.deepEqual(result.files[1]!.bytes, raw);
});
test("standard metadata is byte-identical and malformed or incomplete explicit metadata fails", () => {
  const raw = bytes("---\nname: plain\ndescription: Useful\n---\nBody");
  assert.deepEqual(
    prepareInstalledFiles(
      [{ path: "SKILL.md", bytes: raw }],
      "plain",
      "Useful",
    ),
    { files: [{ path: "SKILL.md", bytes: raw }] },
  );
  for (const text of [
    "---\nname: [broken\n---\nBody",
    "---\nname: plain\n---\nBody",
  ])
    assert.throws(() =>
      prepareInstalledFiles(
        [{ path: "SKILL.md", bytes: bytes(text) }],
        "plain",
        "Useful",
      ),
    );
});

test("generated original backups avoid case-insensitive file and directory collisions", () => {
  const raw = bytes("# title\n\nBody");
  const digest = sha256(raw);
  const source = [
    { path: "SKILL.md", bytes: raw },
    {
      path: `.SOURCEWEFT-ORIGINAL-${digest.slice(0, 12)}.md`,
      bytes: bytes("other"),
    },
    {
      path: `.sourceweft-original-${digest}.md/file`,
      bytes: bytes("directory"),
    },
  ];
  const result = prepareInstalledFiles(source, "title", "Body");
  assert.equal(result.originalSkillMd, `.sourceweft-original-${digest}-1.md`);
  assert.equal(result.files.length, 4);
});
