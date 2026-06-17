import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileInfo } from "deepagents";
import { MountedAgentFilesystemBackend } from "../src/index";

function textData(content: string) {
  return {
    data: {
      content,
      mimeType: "text/plain",
      created_at: "",
      modified_at: "",
    },
  };
}

test("mounted backend exposes roots, defaults search to /kb, and restricts writes", async () => {
  const knowledge = {
    ls: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    read: async () => ({ content: "kb" }),
    readRaw: async () => textData("kb"),
    grep: async () => ({
      matches: [{ path: "/kb/source.md", line: 1, text: "kb" }],
    }),
    glob: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const working = {
    ls: async () => ({ files: [{ path: "/workfiles/a.md", is_dir: false }] }),
    read: async () => ({ content: "work" }),
    readRaw: async () => textData("work"),
    grep: async () => ({
      matches: [{ path: "/workfiles/a.md", line: 1, text: "work" }],
    }),
    glob: async () => ({ files: [{ path: "/workfiles/a.md", is_dir: false }] }),
    write: async (path: string) => ({ path }),
    edit: async (path: string) => ({ path, occurrences: 1 }),
  };

  const backend = new MountedAgentFilesystemBackend({ knowledge, working });

  assert.deepEqual(
    (await backend.ls("/")).files?.map((item: FileInfo) => item.path),
    ["/kb/", "/workfiles/"],
  );
  assert.equal(
    (await backend.write("/kb/a.md", "x")).error?.startsWith("EROFS"),
    true,
  );
  assert.equal(
    (await backend.write("/workfiles/a.md", "x")).path,
    "/workfiles/a.md",
  );
  assert.deepEqual((await backend.grep("anything", "/")).matches, [
    { path: "/kb/source.md", line: 1, text: "kb" },
  ]);
  assert.deepEqual((await backend.glob("/workfiles/**/*.md", "/")).files, [
    { path: "/workfiles/a.md", is_dir: false },
  ]);
});

test("mounted backend exposes optional /skills mount as read-only", async () => {
  const knowledge = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "kb" }),
    readRaw: async () => textData("kb"),
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const working = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "work" }),
    readRaw: async () => textData("work"),
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
    write: async (path: string) => ({ path }),
    edit: async (path: string) => ({ path, occurrences: 1 }),
  };
  const skills = {
    ls: async () => ({ files: [{ path: "/skill-a/SKILL.md", is_dir: false }] }),
    read: async () => ({ content: "skill" }),
    readRaw: async () => textData("skill"),
    grep: async () => ({
      matches: [{ path: "/skill-a/SKILL.md", line: 1, text: "skill" }],
    }),
    glob: async () => ({
      files: [{ path: "/skill-a/SKILL.md", is_dir: false }],
    }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };

  const backend = new MountedAgentFilesystemBackend({
    knowledge,
    working,
    skills,
  });

  assert.deepEqual(
    (await backend.ls("/")).files?.map((item: FileInfo) => item.path),
    ["/kb/", "/skills/", "/workfiles/"],
  );
  assert.deepEqual((await backend.ls("/skills")).files, [
    { path: "/skills/skill-a/SKILL.md", is_dir: false },
  ]);
  assert.deepEqual((await backend.grep("skill", "/skills")).matches, [
    { path: "/skills/skill-a/SKILL.md", line: 1, text: "skill" },
  ]);
  assert.equal(
    (await backend.write("/skills/skill-a/new.md", "x")).error?.startsWith(
      "EROFS",
    ),
    true,
  );
});

test("mounted backend routes upload and download by mount", async () => {
  const calls: string[] = [];
  let knowledgeReadRawCalls = 0;
  const knowledge = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "kb" }),
    readRaw: async (path: string) => {
      knowledgeReadRawCalls += 1;
      return textData(`kb:${path}`);
    },
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const working = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "work" }),
    readRaw: async (path: string) => textData(`work:${path}`),
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
    write: async (path: string, content: string) => {
      calls.push(`${path}:${content}`);
      return { path };
    },
    edit: async () => ({ path: "/workfiles/a.md", occurrences: 1 }),
  };
  const skills = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "skill" }),
    readRaw: async () => textData("skill"),
    downloadFiles: async (paths: string[]) =>
      paths.map((path) => ({
        path,
        content: new TextEncoder().encode(`skill:${path}`),
        error: null,
      })),
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const backend = new MountedAgentFilesystemBackend({
    knowledge,
    working,
    skills,
  });

  const downloads = await backend.downloadFiles([
    "/kb/a.md",
    "/workfiles/a.md",
    "/skills/skill-a/SKILL.md",
    "/conversation_history/session.md",
  ]);
  assert.equal(downloads[0]!.error, "permission_denied");
  assert.equal(downloads[0]!.content, null);
  assert.equal(
    new TextDecoder().decode(downloads[1]!.content!),
    "work:/workfiles/a.md",
  );
  assert.equal(
    new TextDecoder().decode(downloads[2]!.content!),
    "skill:/skill-a/SKILL.md",
  );
  assert.equal(downloads[3]!.error, "invalid_path");
  assert.equal(knowledgeReadRawCalls, 0);

  const uploads = await backend.uploadFiles([
    ["/workfiles/a.md", new TextEncoder().encode("hello")],
    ["/kb/a.md", new TextEncoder().encode("no")],
    ["/conversation_history/session.md", new TextEncoder().encode("no")],
  ]);
  assert.equal(uploads[0]!.error, null);
  assert.equal(uploads[1]!.error, "permission_denied");
  assert.equal(uploads[2]!.error, "permission_denied");
  assert.deepEqual(calls, ["/workfiles/a.md:hello"]);
});
