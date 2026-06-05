import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { basicProductOverviewFixture } from "./__fixtures__";
import { PptxGenJsRendererAdapter } from "./adapters/pptxgenjs-renderer-adapter";

const composerRoot = dirname(fileURLToPath(import.meta.url));

const forbiddenDependencyPatterns = [
  { label: "remotion package import", pattern: /from\s+["']@remotion\// },
  { label: "remotion runtime import", pattern: /from\s+["']remotion["']/ },
  { label: "remotion package dynamic import", pattern: /import\(\s*["']@remotion\// },
  { label: "remotion runtime dynamic import", pattern: /import\(\s*["']remotion["']/ },
  { label: "remotion package require", pattern: /require\(\s*["']@remotion\// },
  { label: "remotion runtime require", pattern: /require\(\s*["']remotion["']/ },
  { label: "video presentation module", pattern: /video-presentation/ },
  { label: "HTML deck builder", pattern: /buildVisualHtml/ },
  { label: "legacy visual HTML mode", pattern: /visual_html/ },
  { label: "HTML iframe artifact", pattern: /html_iframe/ },
  { label: "video generation module", pattern: /generate-video/ },
];

test("composer source has no Remotion, video, or HTML-renderer dependencies", async () => {
  const sourceFiles = await listComposerSourceFiles(composerRoot);
  const violations: string[] = [];

  for (const filePath of sourceFiles) {
    const content = await readFile(filePath, "utf8");
    for (const forbidden of forbiddenDependencyPatterns) {
      if (forbidden.pattern.test(content)) {
        violations.push(`${relative(composerRoot, filePath)} imports or references ${forbidden.label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("native PPTX adapter renders without the visual HTML or video path", async () => {
  const adapter = new PptxGenJsRendererAdapter();

  const result = await adapter.renderPresentation({
    source: basicProductOverviewFixture,
    options: { sourceHash: "guardrail-native-render" },
  });

  assert.ok(Buffer.isBuffer(result.pptxBuffer));
  assert.ok(result.pptxBuffer.byteLength > 1000);
  assert.equal(result.metadata.engine, "pptxgenjs-native");
  assert.equal(result.metadata.sourceHash, "guardrail-native-render");
  assert.equal(result.metadata.slideCount, basicProductOverviewFixture.slides.length);
  assert.equal(result.metadata.editableCompatibility, "native-v1");
});

async function listComposerSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listComposerSourceFiles(fullPath);
      }
      if (entry.isFile() && shouldScanSourceFile(fullPath)) {
        return [fullPath];
      }
      return [];
    }),
  );

  return files.flat().sort();
}

function shouldScanSourceFile(filePath: string) {
  const relativePath = relative(composerRoot, filePath);
  return (
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".test.ts") &&
    !filePath.endsWith(".spec.ts") &&
    !relativePath.split(sep).includes("__fixtures__")
  );
}
