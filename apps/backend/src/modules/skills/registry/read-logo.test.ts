import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { readRegistrySkillsFromGitHub } from "./read";
import { extractRegistryLogo } from "./logo";

const archive = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
vi.mock("../../market/parser/github-zip", async (original) => ({
  ...(await original<typeof import("../../market/parser/github-zip")>()),
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
}));

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
