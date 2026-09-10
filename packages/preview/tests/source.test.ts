import { describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_BYTES,
  previewFamily,
  previewFileName,
  readPreviewBlob,
} from "../src/index";

describe("preview sources", () => {
  it("routes legacy PowerPoint separately, including MIME-only files and PC paths", () => {
    expect(previewFamily("C:\\files\\DECK.PPT")).toBe("legacyPresentation");
    expect(previewFamily("/workfiles/template.pot")).toBe("legacyPresentation");
    const name = previewFileName(
      "Presentation",
      "application/vnd.ms-powerpoint",
    );
    expect(name).toBe("Presentation.ppt");
    expect(previewFamily(name)).toBe("legacyPresentation");
    expect(previewFamily("Presentation.pptx")).toBe("presentation");
  });
  it("handles native paths and MIME-only titles without enabling heavy formats", () => {
    expect(previewFamily("C:\\files\\DECK.PPTX")).toBe("presentation");
    expect(previewFileName("Report", "application/pdf")).toBe("Report.pdf");
    expect(previewFileName("README", "text/markdown")).toBe("README.md");
    for (const name of [
      "drawing.dwg",
      "part.stl",
      "sheet.numbers",
      "document.hwp",
      "archive.zip",
    ])
      expect(previewFamily(name)).toBeNull();
  });
  it("retains exact binary bytes", async () => {
    const bytes = new Uint8Array([0, 255, 128, 65]);
    const blob = await readPreviewBlob(new Response(bytes));
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
  it("rejects oversized declared and chunked responses", async () => {
    await expect(
      readPreviewBlob(
        new Response("x", {
          headers: { "content-length": String(MAX_PREVIEW_BYTES + 1) },
        }),
      ),
    ).rejects.toThrow("32 MB");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(readPreviewBlob(new Response(stream))).rejects.toThrow(
      "32 MB",
    );
  });
  it("reports unsuccessful HTTP responses", async () => {
    await expect(
      readPreviewBlob(new Response(null, { status: 403 })),
    ).rejects.toThrow("403");
  });
});
