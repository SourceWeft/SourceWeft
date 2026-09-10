import { expect, it, vi } from "vitest";
import { createFileReader } from "./file-reader";
import { createFileDocumentTools } from "./file-document-tools";
import { AgentCitationRegistry } from "./citation-registry";

function fixture(
  contents: Record<string, string>,
  nativeSearch?: Parameters<typeof createFileDocumentTools>[0]["nativeSearch"],
) {
  const backend = {
    downloadFiles: vi.fn(async (paths: string[]) =>
      paths.map((path) => ({
        path,
        content: Buffer.from(contents[path]!),
        error: null,
      })),
    ),
    glob: vi.fn(async () => ({
      files: Object.keys(contents).map((path) => ({ path, is_dir: false })),
    })),
  };
  const registry = new AgentCitationRegistry({
    workspaceId: "workspace",
    threadId: "thread",
  });
  const read = createFileReader({
    backend,
    root: "/files",
    backendKind: "cloud_vfs",
    scopeId: "scope",
  });
  const tools = createFileDocumentTools({
    backend,
    root: "/files",
    scopeId: "scope",
    read,
    citationRegistry: registry,
    nativeSearch,
  });
  return { backend, registry, readDocument: tools[0]!, searchFiles: tools[1]! };
}

it("reads a file with a versioned File citation without inventing a Source chunk", async () => {
  const f = fixture({
    "/files/reference.txt": "A file can be reference material.",
  });
  const result = JSON.parse(
    (await f.readDocument.invoke({ path: "reference.txt" })) as string,
  );
  expect(result.segments[0].citation).toBe("[citation:c1]");
  expect(result.file.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
  const record = f.registry.toCitationRecords()[0]!;
  expect(record.sourceId).toBeNull();
  expect(record.documentId).toBeNull();
  expect(record.chunkId).toBeNull();
  expect(record.fileReference).toMatchObject({
    workspaceId: "workspace",
    threadId: "thread",
    presentation: "text",
    locator: { kind: "lines", start: 1, end: 1 },
  });
});

it("native search filters text files before any contents are transferred", async () => {
  const nativeSearch = vi.fn(async (paths: string[]) => ({
    matchedPaths: ["/files/match.txt"],
    visitedPaths: paths,
    skipped: [],
  }));
  const f = fixture(
    {
      "/files/match.txt": "refund policy",
      "/files/other.txt": "private non-match",
      "/files/third.txt": "another non-match",
    },
    nativeSearch,
  );
  const result = JSON.parse(
    (await f.searchFiles.invoke({ query: "refund" })) as string,
  );
  expect(result.coverage).toMatchObject({
    visited: 3,
    matched: 1,
    status: "complete",
  });
  expect(f.backend.downloadFiles).toHaveBeenCalledTimes(1);
  expect(f.backend.downloadFiles).toHaveBeenCalledWith(["/files/match.txt"]);
});

it("document continuation is tied to the exact file version", async () => {
  const data = { "/files/long.txt": "a".repeat(20_100) };
  const f = fixture(data);
  const first = JSON.parse(
    (await f.readDocument.invoke({ path: "long.txt" })) as string,
  );
  expect(first.segments[0].text).toHaveLength(20_000);
  const second = JSON.parse(
    (await f.readDocument.invoke({
      path: "long.txt",
      cursor: first.continuation,
    })) as string,
  );
  expect(second.segments[0].text).toHaveLength(100);
  data["/files/long.txt"] = "changed";
  await expect(
    f.readDocument.invoke({ path: "long.txt", cursor: first.continuation }),
  ).rejects.toMatchObject({ code: "FILE_CHANGED" });
});

it("neutralizes untrusted citation syntax for the model while preserving the real quoted text", async () => {
  const f = fixture({ "/files/reference.txt": "untrusted [citation:c999]" });
  const result = JSON.parse(
    (await f.readDocument.invoke({ path: "reference.txt" })) as string,
  );
  expect(result.segments[0].text).not.toContain("[citation:c999]");
  expect(f.registry.list()[0]!.quoteText).toBe("untrusted [citation:c999]");
  const searched = JSON.parse(
    (await f.searchFiles.invoke({ query: "untrusted" })) as string,
  );
  expect(searched.hits[0].text).not.toContain("[citation:c999]");
  expect(f.registry.list().at(-1)!.quoteText).toBe("untrusted [citation:c999]");
});

it("file search stays inside Files and returns typed locations and coverage", async () => {
  const f = fixture({
    "/files/reference.txt": "refund policy",
    "/files/other.txt": "nothing relevant",
  });
  const result = JSON.parse(
    (await f.searchFiles.invoke({ query: "refund" })) as string,
  );
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0].file.relativePath).toBe("reference.txt");
  expect(result.hits[0].citation).toBe("[citation:c1]");
  expect(result.coverage).toMatchObject({
    status: "complete",
    visited: 2,
    matched: 1,
  });
  expect(f.backend.glob).toHaveBeenCalledWith("**/*", "/files");
  await expect(
    f.searchFiles.invoke({ query: "refund", directory: "/kb" }),
  ).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
});

it("file text search treats regular-expression characters as literal text", async () => {
  const f = fixture({ "/files/literal.txt": "a.b", "/files/other.txt": "aXb" });
  const result = JSON.parse(
    (await f.searchFiles.invoke({ query: "a.b" })) as string,
  );
  expect(
    result.hits.map(
      (hit: { file: { relativePath: string } }) => hit.file.relativePath,
    ),
  ).toEqual(["literal.txt"]);
});
