import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { collectSkillFiles } from "./builtin";

// A builtin skill package may ship what its scripts work with — fonts, images,
// templates. Every file used to be read as UTF-8, which silently corrupts them.

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
// Invalid UTF-8 plus NULs, like the head of a real TrueType file.
const FONT = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x00]);

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "builtin-skill-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "SKILL.md"), "---\nname: poster\n---\nBody\n");
  await writeFile(join(dir, "assets", "Inter.ttf"), FONT);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("text is text, a font is bytes, and both are hashed over what is on disk", async () => {
  const files = await collectSkillFiles(dir);
  const byPath = new Map(files.map((file) => [file.path, file]));

  const skillMd = byPath.get("SKILL.md")!;
  assert.equal(skillMd.isText, true);
  assert.equal(skillMd.mimeType, "text/markdown");
  assert.equal(skillMd.contentHash, sha("---\nname: poster\n---\nBody\n"));

  const font = byPath.get("assets/Inter.ttf")!;
  assert.equal(font.isText, false);
  assert.equal(font.contentText, null);
  assert.equal(font.mimeType, "font/ttf");
  assert.equal(font.sizeBytes, FONT.byteLength);
  assert.equal(font.contentHash, sha(FONT));
  assert.ok(font.isText === false);
  assert.deepEqual(new Uint8Array(await font.readBytes()), FONT);
});

test("a binary that changed on disk is hashed again, not answered from memory", async () => {
  const first = (await collectSkillFiles(dir)).find(
    (file) => file.path === "assets/Inter.ttf",
  )!;
  // Unchanged: same answer.
  const again = (await collectSkillFiles(dir)).find(
    (file) => file.path === "assets/Inter.ttf",
  )!;
  assert.equal(again.contentHash, first.contentHash);

  const replaced = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x80]);
  const path = join(dir, "assets", "Inter.ttf");
  await writeFile(path, replaced);
  const later = new Date(Date.now() + 5000);
  await utimes(path, later, later);

  const changed = (await collectSkillFiles(dir)).find(
    (file) => file.path === "assets/Inter.ttf",
  )!;
  assert.equal(changed.contentHash, sha(replaced));
  assert.equal(changed.sizeBytes, replaced.byteLength);
});
