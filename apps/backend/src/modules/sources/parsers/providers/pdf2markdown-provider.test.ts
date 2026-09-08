import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { resolvePhysicalPageCount } from "../../billing-pages";

const client = vi.hoisted(() => ({ count: undefined as number | undefined }));
vi.mock("./pdf2markdown-client", () => ({
  getPdf2MarkdownTaskStatus: async () => ({ status: "completed" }),
  getPdf2MarkdownTaskResult: async () => ({
    page_count: client.count,
    result: { url: "https://fixture.test/result" },
  }),
  downloadPdf2MarkdownResult: async () => ({
    markdown: "OCR extracted content",
  }),
  submitPdf2MarkdownAsync: vi.fn(),
}));
import { pdf2MarkdownProvider } from "./pdf2markdown-provider";

for (const count of [undefined, 0, 2]) {
  test(`OCR declared page count ${String(count)} is distinguished from a synthetic markdown page`, async () => {
    client.count = count;
    const outcome = await pdf2MarkdownProvider.resume!(
      {
        backendId: "pdf2markdown",
        taskId: "task",
        sourceId: "source",
        teamId: "team",
        workspaceId: "workspace",
        userId: "user",
        fileName: "scan.pdf",
        mimeType: "application/pdf",
        fileSize: 3,
        parsingConfig: { chunkSize: 512, parserVersion: "test" },
        attempt: 0,
      },
      Buffer.from("pdf"),
    );
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    const metadata = outcome.document.metadata;
    assert.equal(
      metadata.pageCountSource,
      count === undefined ? "unknown" : "ocr",
    );
    if (count === 0)
      assert.throws(
        () =>
          resolvePhysicalPageCount({ mimeType: "application/pdf", metadata }),
        /positive safe integer/,
      );
    else
      assert.equal(
        resolvePhysicalPageCount({ mimeType: "application/pdf", metadata }),
        count,
      );
  });
}
