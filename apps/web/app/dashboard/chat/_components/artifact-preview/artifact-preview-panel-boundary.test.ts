import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shellSourcePath = fileURLToPath(
  new URL("./artifact-preview-panel.tsx", import.meta.url),
);

describe("ArtifactPreviewPanel boundary", () => {
  it("keeps feature-specific preview logic out of the generic shell", () => {
    const source = readFileSync(shellSourcePath, "utf8");

    expect(source).not.toMatch(/artifact\.artifactType\s*===/);
    expect(source).not.toContain("numericAspectRatio");
    expect(source).not.toContain("slideLayoutForAspectRatio");
    expect(source).not.toContain("slidePixelSizeForAspectRatio");
    expect(source).not.toContain("VisualHtmlDeckPreview");
    expect(source).not.toContain("VideoPresentationPreview");
    expect(source).not.toContain("PptxViewJsPreview");
  });
});
