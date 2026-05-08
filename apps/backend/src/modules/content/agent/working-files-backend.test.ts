import assert from "node:assert/strict";
import test from "node:test";
import { WorkingFilesBackend } from "./working-files-backend";
import { MountedAgentFilesystemBackend } from "./mounted-fs-backend";
import type { WorkingFileRecord } from "../types";
import { toWorkingFileListItem, workingFilesService } from "../working-files";

function record(input: {
  path: string;
  contentText: string;
  updatedAt?: string;
}): WorkingFileRecord {
  return {
    id: `wf-${input.path}`,
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    path: input.path,
    contentText: input.contentText,
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(input.contentText),
    purpose: null,
    createdBy: "user-1",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-08T00:00:00.000Z",
  };
}

test("WorkingFilesBackend lists virtual directories from file paths", async (t) => {
  const originalList = workingFilesService.listForBackend;
  workingFilesService.listForBackend = async () => [
    record({ path: "/work/notes/todo.md", contentText: "todo" }),
    record({ path: "/work/final.md", contentText: "final" }),
  ];
  t.after(() => {
    workingFilesService.listForBackend = originalList;
  });

  const backend = new WorkingFilesBackend({
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
  });

  assert.deepEqual(
    (await backend.ls("/work")).files?.map((item) => [item.path, item.is_dir]),
    [
      ["/work/final.md", false],
      ["/work/notes/", true],
    ],
  );
  assert.deepEqual(
    (await backend.ls("/work/notes")).files?.map((item) => item.path),
    ["/work/notes/todo.md"],
  );
});

test("WorkingFilesBackend read and grep do not create citations", async (t) => {
  const originalList = workingFilesService.listForBackend;
  const originalGet = workingFilesService.getWorkingFile;
  const file = record({
    path: "/work/notes/todo.md",
    contentText: "alpha\nbeta evidence",
  });
  workingFilesService.listForBackend = async () => [file];
  workingFilesService.getWorkingFile = async () => ({ file });
  t.after(() => {
    workingFilesService.listForBackend = originalList;
    workingFilesService.getWorkingFile = originalGet;
  });

  const backend = new WorkingFilesBackend({
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
  });

  const read = await backend.read("/work/notes/todo.md");
  assert.equal(read.mimeType, "text/markdown");
  assert.match(String(read.content), /thread working memory/i);
  assert.match(String(read.content), /not source evidence/);
  assert.doesNotMatch(String(read.content), /\[citation:/);

  const grep = await backend.grep("evidence", "/work");
  assert.equal(grep.matches?.[0]?.path, "/work/notes/todo.md");
  assert.doesNotMatch(grep.matches?.[0]?.text ?? "", /\[citation:/);
});

test("WorkingFilesBackend write and edit persist through service", async (t) => {
  const originalPut = workingFilesService.putWorkingFile;
  const writes: Array<{ path: string; contentText: string }> = [];
  workingFilesService.putWorkingFile = async (input) => {
    writes.push({ path: input.path, contentText: input.contentText });
    return {
      file: record({
        path: input.path,
        contentText: input.contentText,
      }),
    };
  };
  const originalGet = workingFilesService.getWorkingFile;
  workingFilesService.getWorkingFile = async () => ({
    file: record({ path: "/work/a.md", contentText: "hello world" }),
  });
  t.after(() => {
    workingFilesService.putWorkingFile = originalPut;
    workingFilesService.getWorkingFile = originalGet;
  });

  const backend = new WorkingFilesBackend({
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
  });

  assert.equal((await backend.write("/work/a.md", "hello")).path, "/work/a.md");
  const edit = await backend.edit("/work/a.md", "world", "there");
  assert.equal(edit.occurrences, 1);
  assert.deepEqual(writes.map((item) => item.contentText), ["hello", "hello there"]);
});

test("toWorkingFileListItem omits file content", () => {
  const file = record({
    path: "/work/notes/todo.md",
    contentText: "private draft",
  });
  const item = toWorkingFileListItem(file);

  assert.equal(item.path, "/work/notes/todo.md");
  assert.equal("contentText" in item, false);
});

test("MountedAgentFilesystemBackend exposes /kb and /work roots, defaults search to /kb, and restricts writes", async () => {
  const knowledge = {
    ls: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    read: async () => ({ content: "kb" }),
    readRaw: async () => ({ data: { content: "kb", mimeType: "text/plain", created_at: "", modified_at: "" } }),
    grep: async () => ({ matches: [{ path: "/kb/source.md", line: 1, text: "kb" }] }),
    glob: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const working = {
    ls: async () => ({ files: [{ path: "/work/a.md", is_dir: false }] }),
    read: async () => ({ content: "work" }),
    readRaw: async () => ({ data: { content: "work", mimeType: "text/plain", created_at: "", modified_at: "" } }),
    grep: async () => ({ matches: [{ path: "/work/a.md", line: 1, text: "work" }] }),
    glob: async () => ({ files: [{ path: "/work/a.md", is_dir: false }] }),
    write: async (path: string) => ({ path }),
    edit: async (path: string) => ({ path, occurrences: 1 }),
  };

  const backend = new MountedAgentFilesystemBackend({ knowledge, working });
  assert.deepEqual((await backend.ls("/")).files?.map((item) => item.path), [
    "/kb/",
    "/work/",
  ]);
  assert.equal((await backend.write("/kb/a.md", "x")).error?.startsWith("EROFS"), true);
  assert.equal((await backend.write("/work/a.md", "x")).path, "/work/a.md");
  assert.deepEqual((await backend.grep("anything", "/")).matches, [
    { path: "/kb/source.md", line: 1, text: "kb" },
  ]);
  assert.deepEqual((await backend.glob("**/*.md", "/")).files, [
    { path: "/kb/source.md", is_dir: false },
  ]);
  assert.deepEqual((await backend.grep("anything", "/work")).matches, [
    { path: "/work/a.md", line: 1, text: "work" },
  ]);
  assert.deepEqual((await backend.glob("/work/**/*.md", "/")).files, [
    { path: "/work/a.md", is_dir: false },
  ]);
});

test("MountedAgentFilesystemBackend exposes optional /skills mount as read-only", async () => {
  const knowledge = {
    ls: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    read: async () => ({ content: "kb" }),
    readRaw: async () => ({ data: { content: "kb", mimeType: "text/plain", created_at: "", modified_at: "" } }),
    grep: async () => ({ matches: [{ path: "/kb/source.md", line: 1, text: "kb" }] }),
    glob: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const working = {
    ls: async () => ({ files: [{ path: "/work/a.md", is_dir: false }] }),
    read: async () => ({ content: "work" }),
    readRaw: async () => ({ data: { content: "work", mimeType: "text/plain", created_at: "", modified_at: "" } }),
    grep: async () => ({ matches: [{ path: "/work/a.md", line: 1, text: "work" }] }),
    glob: async () => ({ files: [{ path: "/work/a.md", is_dir: false }] }),
    write: async (path: string) => ({ path }),
    edit: async (path: string) => ({ path, occurrences: 1 }),
  };
  const skills = {
    ls: async () => ({ files: [{ path: "/skill-a/SKILL.md", is_dir: false }] }),
    read: async () => ({ content: "skill" }),
    readRaw: async () => ({ data: { content: "skill", mimeType: "text/plain", created_at: "", modified_at: "" } }),
    grep: async () => ({ matches: [{ path: "/skill-a/SKILL.md", line: 1, text: "skill" }] }),
    glob: async () => ({ files: [{ path: "/skill-a/SKILL.md", is_dir: false }] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };

  const backend = new MountedAgentFilesystemBackend({ knowledge, working, skills });

  assert.deepEqual((await backend.ls("/")).files?.map((item) => item.path), [
    "/kb/",
    "/skills/",
    "/work/",
  ]);
  assert.deepEqual((await backend.ls("/skills")).files, [
    { path: "/skills/skill-a/SKILL.md", is_dir: false },
  ]);
  assert.deepEqual((await backend.grep("skill", "/skills")).matches, [
    { path: "/skills/skill-a/SKILL.md", line: 1, text: "skill" },
  ]);
  assert.equal((await backend.write("/skills/skill-a/new.md", "x")).error?.startsWith("EROFS"), true);
});
