import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentCitationRegistry } from "./citation-registry";
import { WorkingFilesBackend } from "./working-files-backend";
import { MountedAgentFilesystemBackend } from "@sourceweft/builtin-vfs";
import { ContentError } from "../../content/errors";
import type { WorkingFileRecord } from "../../content/types";
import {
  toWorkingFileListItem,
  workingFilesService,
} from "../../working-files";

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

test("WorkingFilesBackend lists virtual directories from file paths", async () => {
  const originalList = workingFilesService.listForBackend;
  workingFilesService.listForBackend = async () => [
    record({ path: "/workfiles/notes/todo.md", contentText: "todo" }),
    record({ path: "/workfiles/final.md", contentText: "final" }),
  ];
  try {
    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
    });

    assert.deepEqual(
      (await backend.ls("/workfiles")).files?.map((item) => [
        item.path,
        item.is_dir,
      ]),
      [
        ["/workfiles/final.md", false],
        ["/workfiles/notes/", true],
      ],
    );
    assert.deepEqual(
      (await backend.ls("/workfiles/notes")).files?.map((item) => item.path),
      ["/workfiles/notes/todo.md"],
    );
  } finally {
    workingFilesService.listForBackend = originalList;
  }
});

test("WorkingFilesBackend read and grep do not create citations", async () => {
  const originalList = workingFilesService.listForBackend;
  const originalGet = workingFilesService.getWorkingFile;
  const file = record({
    path: "/workfiles/notes/todo.md",
    contentText: "alpha\nbeta evidence",
  });
  workingFilesService.listForBackend = async () => [file];
  workingFilesService.getWorkingFile = async () => ({ file });
  try {
    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
    });

    const read = await backend.read("/workfiles/notes/todo.md");
    assert.equal(read.mimeType, "text/markdown");
    assert.match(String(read.content), /thread working memory/i);
    assert.match(String(read.content), /not source evidence/);
    assert.doesNotMatch(String(read.content), /\[citation:/);

    const grep = await backend.grep("evidence", "/workfiles");
    assert.equal(grep.matches?.[0]?.path, "/workfiles/notes/todo.md");
    assert.doesNotMatch(grep.matches?.[0]?.text ?? "", /\[citation:/);
  } finally {
    workingFilesService.listForBackend = originalList;
    workingFilesService.getWorkingFile = originalGet;
  }
});

test("WorkingFilesBackend missing reads direct source mentions back to /kb", async () => {
  const originalGet = workingFilesService.getWorkingFile;
  workingFilesService.getWorkingFile = async () =>
    Promise.reject(
      new ContentError(404, "WORKING_FILE_NOT_FOUND", "Working file not found"),
    );
  try {
    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
    });

    const read = await backend.read(
      "/workfiles/043e27f7-c8e0-438e-a47f-adcf8b06088e.pdf",
    );

    assert.match(read.error ?? "", /no such thread working file/);
    assert.match(
      read.error ?? "",
      /uploaded, selected, referenced, attached, or @mentioned source/,
    );
    assert.match(read.error ?? "", /Source Library under \/kb/);
  } finally {
    workingFilesService.getWorkingFile = originalGet;
  }
});

test("WorkingFilesBackend preserves non-not-found getWorkingFile errors", async () => {
  const originalGet = workingFilesService.getWorkingFile;
  workingFilesService.getWorkingFile = async () =>
    Promise.reject(new ContentError(403, "WORKFILE_SCOPE_DENIED", "scope denied"));
  try {
    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
    });

    const read = await backend.readRaw("/workfiles/notes/todo.md");

    assert.match(read.error ?? "", /scope denied/);
    assert.doesNotMatch(read.error ?? "", /no such thread working file/);
  } finally {
    workingFilesService.getWorkingFile = originalGet;
  }
});

test("WorkingFilesBackend neutralizes citation-like markers in agent-facing reads", async () => {
  const originalGet = workingFilesService.getWorkingFile;
  const file = record({
    path: "/workfiles/notes/todo.md",
    contentText:
      "alpha [citation:c1]\nbeta citation:c2\ngamma 【citation: c3, c4】",
  });
  workingFilesService.getWorkingFile = async () => ({ file });
  try {
    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
    });

    const read = await backend.read("/workfiles/notes/todo.md");
    assert.doesNotMatch(String(read.content), /\[citation:c1\]/i);
    assert.match(
      String(read.content),
      /non-citable citation marker c1 removed/i,
    );

    const [download] = await backend.downloadFiles([
      "/workfiles/notes/todo.md",
    ]);
    assert.equal(download?.error, null);
    const downloaded = download?.content
      ? new TextDecoder().decode(download.content)
      : "";
    assert.doesNotMatch(downloaded, /\[citation:c1\]/i);
    assert.match(downloaded, /non-citable citation marker c2 removed/i);
    assert.doesNotMatch(downloaded, /【citation:/i);
    assert.match(downloaded, /non-citable citation marker c3, c4 removed/i);
  } finally {
    workingFilesService.getWorkingFile = originalGet;
  }
});

test("WorkingFilesBackend write and edit persist through service", async () => {
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
    file: record({ path: "/workfiles/a.md", contentText: "hello world" }),
  });
  try {
    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
    });

    assert.equal(
      (await backend.write("/workfiles/a.md", "hello")).path,
      "/workfiles/a.md",
    );
    const edit = await backend.edit("/workfiles/a.md", "world", "there");
    assert.equal(edit.occurrences, 1);
    assert.deepEqual(
      writes.map((item) => item.contentText),
      ["hello", "hello there"],
    );
  } finally {
    workingFilesService.putWorkingFile = originalPut;
    workingFilesService.getWorkingFile = originalGet;
  }
});

test("WorkingFilesBackend rewrites runtime citations to markdown footnotes on write", async () => {
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
  try {
    const citationRegistry = new AgentCitationRegistry();
    citationRegistry.addExternal({
      origin: "web_fetch",
      externalUri: "https://example.com/article",
      sourceTitle: "Example Article",
      content: "Example content",
    });
    citationRegistry.addChunk({
      origin: "read_file",
      sourceId: "source-1",
      sourceTitle: "Annual Report 2025.pdf",
      documentId: "doc-1",
      chunkId: "chunk-1",
      chunkNo: 0,
      content: "Annual report content",
    });

    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      citationRegistry,
    });

    await backend.write(
      "/workfiles/notes.md",
      "Web claim [citation:c1]\nSource claim [citation:c2]\nAgain [citation:c1]",
    );

    assert.equal(
      writes[0]?.contentText,
      [
        "Web claim [^example-article]",
        "Source claim [^annual-report-2025-pdf]",
        "Again [^example-article]",
        "",
        "## References",
        "",
        "[^example-article]: Example Article. https://example.com/article",
        "[^annual-report-2025-pdf]: Source Library: Annual Report 2025.pdf.",
      ].join("\n"),
    );
  } finally {
    workingFilesService.putWorkingFile = originalPut;
  }
});

test("WorkingFilesBackend reuses existing footnote definitions and removes unknown citations", async () => {
  const originalPut = workingFilesService.putWorkingFile;
  const writes: string[] = [];
  workingFilesService.putWorkingFile = async (input) => {
    writes.push(input.contentText);
    return {
      file: record({
        path: input.path,
        contentText: input.contentText,
      }),
    };
  };
  try {
    const citationRegistry = new AgentCitationRegistry();
    citationRegistry.addExternal({
      origin: "web_fetch",
      externalUri: "https://example.com/article",
      sourceTitle: "Example Article",
      content: "Example content",
    });

    const backend = new WorkingFilesBackend({
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      citationRegistry,
    });

    await backend.write(
      "/workfiles/notes.md",
      [
        "Existing [^custom-ref]",
        "",
        "## References",
        "",
        "[^custom-ref]: Example Article. https://example.com/article",
        "",
        "New [citation:c1] Missing [citation:c99]",
      ].join("\n"),
    );

    assert.equal(
      writes[0],
      [
        "Existing [^custom-ref]",
        "",
        "## References",
        "",
        "[^custom-ref]: Example Article. https://example.com/article",
        "",
        "New [^custom-ref] Missing [non-citable citation marker c99 removed]",
      ].join("\n"),
    );
  } finally {
    workingFilesService.putWorkingFile = originalPut;
  }
});

test("toWorkingFileListItem omits file content", () => {
  const file = record({
    path: "/workfiles/notes/todo.md",
    contentText: "private draft",
  });
  const item = toWorkingFileListItem(file);

  assert.equal(item.path, "/workfiles/notes/todo.md");
  assert.equal("contentText" in item, false);
});

test("MountedAgentFilesystemBackend exposes /kb and /workfiles roots, defaults search to /kb, and restricts writes", async () => {
  const knowledge = {
    ls: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    read: async () => ({ content: "kb" }),
    readRaw: async () => ({
      data: {
        content: "kb",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
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
    readRaw: async () => ({
      data: {
        content: "work",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
    grep: async () => ({
      matches: [{ path: "/workfiles/a.md", line: 1, text: "work" }],
    }),
    glob: async () => ({ files: [{ path: "/workfiles/a.md", is_dir: false }] }),
    write: async (path: string) => ({ path }),
    edit: async (path: string) => ({ path, occurrences: 1 }),
  };

  const backend = new MountedAgentFilesystemBackend({ knowledge, working });
  assert.deepEqual(
    (await backend.ls("/")).files?.map((item) => item.path),
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
  assert.deepEqual((await backend.glob("**/*.md", "/")).files, [
    { path: "/kb/source.md", is_dir: false },
  ]);
  assert.deepEqual((await backend.grep("anything", "/workfiles")).matches, [
    { path: "/workfiles/a.md", line: 1, text: "work" },
  ]);
  assert.deepEqual((await backend.glob("/workfiles/**/*.md", "/")).files, [
    { path: "/workfiles/a.md", is_dir: false },
  ]);
});

test("MountedAgentFilesystemBackend exposes optional /skills mount as read-only", async () => {
  const knowledge = {
    ls: async () => ({ files: [{ path: "/kb/source.md", is_dir: false }] }),
    read: async () => ({ content: "kb" }),
    readRaw: async () => ({
      data: {
        content: "kb",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
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
    readRaw: async () => ({
      data: {
        content: "work",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
    grep: async () => ({
      matches: [{ path: "/workfiles/a.md", line: 1, text: "work" }],
    }),
    glob: async () => ({ files: [{ path: "/workfiles/a.md", is_dir: false }] }),
    write: async (path: string) => ({ path }),
    edit: async (path: string) => ({ path, occurrences: 1 }),
  };
  const skills = {
    ls: async () => ({ files: [{ path: "/skill-a/SKILL.md", is_dir: false }] }),
    read: async () => ({ content: "skill" }),
    readRaw: async () => ({
      data: {
        content: "skill",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
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
    (await backend.ls("/")).files?.map((item) => item.path),
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

test("MountedAgentFilesystemBackend routes upload and download by mount", async () => {
  const calls: string[] = [];
  let knowledgeReadRawCalls = 0;
  const knowledge = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "kb" }),
    readRaw: async (path: string) => {
      knowledgeReadRawCalls += 1;
      return {
        data: {
          content: `kb:${path}`,
          mimeType: "text/plain",
          created_at: "",
          modified_at: "",
        },
      };
    },
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
    write: async () => ({ error: "readonly" }),
    edit: async () => ({ error: "readonly" }),
  };
  const working = {
    ls: async () => ({ files: [] }),
    read: async () => ({ content: "work" }),
    readRaw: async (path: string) => ({
      data: {
        content: `work:${path}`,
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
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
    readRaw: async () => ({
      data: {
        content: "skill",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    }),
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
