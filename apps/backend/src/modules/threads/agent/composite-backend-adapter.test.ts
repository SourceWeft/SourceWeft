import assert from "node:assert/strict";
import {
  CompositeBackend,
  type BackendProtocolV2,
  type FileInfo,
  type GrepMatch,
} from "deepagents";
import { test } from "vitest";
import { PrefixedBackendAdapter } from "./composite-backend-adapter";

function createBackend(): BackendProtocolV2 & {
  calls: Array<[string, unknown[]]>;
} {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    async ls(path: string) {
      calls.push(["ls", [path]]);
      return {
        files: [
          { path: "/files/report.md", is_dir: false },
          { path: "/files/slides/", is_dir: true },
        ] satisfies FileInfo[],
      };
    },
    async read(filePath: string, offset?: number, limit?: number) {
      calls.push(["read", [filePath, offset, limit]]);
      return { content: `read:${filePath}`, mimeType: "text/plain" };
    },
    async readRaw(filePath: string) {
      calls.push(["readRaw", [filePath]]);
      return {
        data: {
          content: `raw:${filePath}`,
          mimeType: "text/plain",
          created_at: "",
          modified_at: "",
        },
      };
    },
    async grep(pattern: string, path?: string | null, glob?: string | null) {
      calls.push(["grep", [pattern, path, glob]]);
      return {
        matches: [
          { path: "/files/report.md", line: 1, text: "hit" },
        ] satisfies GrepMatch[],
      };
    },
    async glob(pattern: string, path?: string) {
      calls.push(["glob", [pattern, path]]);
      return {
        files: [{ path: "/files/report.md", is_dir: false }],
      };
    },
    async write(filePath: string, content: string) {
      calls.push(["write", [filePath, content]]);
      return { path: filePath, filesUpdate: null };
    },
    async edit(
      filePath: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean,
    ) {
      calls.push(["edit", [filePath, oldString, newString, replaceAll]]);
      return { path: filePath, occurrences: 1, filesUpdate: null };
    },
    async downloadFiles(paths: string[]) {
      calls.push(["downloadFiles", [paths]]);
      return paths.map((path) => ({
        path,
        content: new TextEncoder().encode(path),
        error: null,
      }));
    },
    async uploadFiles(files: Array<[string, Uint8Array]>) {
      calls.push(["uploadFiles", [files]]);
      return files.map(([path]) => ({ path, error: null }));
    },
  };
}

test("PrefixedBackendAdapter re-adds stripped CompositeBackend path prefixes", async () => {
  const backend = createBackend();
  const adapter = new PrefixedBackendAdapter("/files", backend);

  assert.deepEqual((await adapter.ls("/")).files, [
    { path: "/report.md", is_dir: false },
    { path: "/slides/", is_dir: true },
  ]);
  assert.equal(
    (await adapter.read("/report.md")).content,
    "read:/files/report.md",
  );
  assert.deepEqual((await adapter.grep("hit", "/", "*.md")).matches, [
    { path: "/report.md", line: 1, text: "hit" },
  ]);
  assert.deepEqual((await adapter.glob("*.md", "/")).files, [
    { path: "/report.md", is_dir: false },
  ]);
  assert.equal((await adapter.write("/draft.md", "x")).path, "/draft.md");
  assert.equal((await adapter.edit("/draft.md", "x", "y")).path, "/draft.md");

  const uploadContent = new Uint8Array([1, 2, 3]);
  await adapter.downloadFiles(["/report.md"]);
  await adapter.uploadFiles([["/new.md", uploadContent]]);

  assert.deepEqual(backend.calls, [
    ["ls", ["/files"]],
    ["read", ["/files/report.md", undefined, undefined]],
    ["grep", ["hit", "/files", "*.md"]],
    ["glob", ["*.md", "/files"]],
    ["write", ["/files/draft.md", "x"]],
    ["edit", ["/files/draft.md", "x", "y", undefined]],
    ["downloadFiles", [["/files/report.md"]]],
    ["uploadFiles", [[["/files/new.md", uploadContent]]]],
  ]);
});

test("CompositeBackend delegates execute to sandbox default and routes SourceWeft paths", async () => {
  const workBackend = createBackend();
  const sandboxBackend = {
    ...createBackend(),
    id: "sandbox-test",
    async execute(command: string) {
      return { output: `executed:${command}`, exitCode: 0, truncated: false };
    },
  };
  const composite = new CompositeBackend(sandboxBackend, {
    "/files/": new PrefixedBackendAdapter("/files", workBackend),
  });

  assert.equal(
    (await composite.read("/workspace/ppt-deck/deck.md")).content,
    "read:/workspace/ppt-deck/deck.md",
  );
  assert.equal(
    (await composite.read("/files/report.md")).content,
    "read:/files/report.md",
  );
  assert.equal((await composite.execute("pwd")).output, "executed:pwd");
});

test("PrefixedBackendAdapter keeps CompositeBackend-stripped routes isolated", async () => {
  const conversationBackend = createBackend();
  const largeResultsBackend = createBackend();
  const sandboxBackend = {
    ...createBackend(),
    id: "sandbox-test",
    async execute(command: string) {
      return { output: `executed:${command}`, exitCode: 0, truncated: false };
    },
  };
  const composite = new CompositeBackend(sandboxBackend, {
    "/conversation_history/": new PrefixedBackendAdapter(
      "/conversation_history",
      conversationBackend,
    ),
    "/large_tool_results/": new PrefixedBackendAdapter(
      "/large_tool_results",
      largeResultsBackend,
    ),
  });

  await composite.write("/conversation_history/messages.txt", "history");
  await composite.write("/large_tool_results/messages.txt", "large");

  assert.deepEqual(conversationBackend.calls, [
    ["write", ["/conversation_history/messages.txt", "history"]],
  ]);
  assert.deepEqual(largeResultsBackend.calls, [
    ["write", ["/large_tool_results/messages.txt", "large"]],
  ]);
});
