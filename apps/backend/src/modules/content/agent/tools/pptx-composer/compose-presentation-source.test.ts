import assert from "node:assert/strict";
import { test } from "vitest";
import { PptxGenJsRendererAdapter } from "./adapters";
import { basicProductOverviewFixture } from "./__fixtures__";
import { createComposePresentationSourceUseCase } from "./use-cases";
import type { PreRenderQaInput } from "./domain/pre-render-qa-validator";
import type { PptxRendererPort } from "./ports";

test("compose use case renders through injected PptxRendererPort", async () => {
  const pptxBuffer = Buffer.from("fake pptx bytes", "utf8");
  const rendererCalls: unknown[] = [];
  const fakeRenderer: PptxRendererPort = {
    async renderPresentation(input) {
      rendererCalls.push(input);
      return {
        pptxBuffer,
        metadata: {
          engine: "pptxgenjs-native",
          slideCount: input.source.slides.length,
          warnings: ["fake-renderer"],
        },
      };
    },
  };
  const fakeQaValidator = async (input: PreRenderQaInput) => ({
    status: "passed" as const,
    issues: [],
    checkedAtIso: `slides:${input.source.slides.length}`,
  });
  const composePresentationSource = createComposePresentationSourceUseCase({
    renderer: fakeRenderer,
    qaValidator: fakeQaValidator,
  });

  const result = await composePresentationSource({
    source: basicProductOverviewFixture,
    renderOptions: { includeSpeakerNotes: true, sourceHash: "test-source" },
  });

  assert.equal(rendererCalls.length, 1);
  assert.equal(result.pptxBuffer, pptxBuffer);
  assert.equal(result.renderMetadata.slideCount, basicProductOverviewFixture.slides.length);
  assert.deepEqual(result.renderMetadata.warnings, ["fake-renderer"]);
  assert.equal(result.qaReport.status, "passed");
  assert.equal(result.renderQaReport.status, "not_run");
  assert.equal(result.renderQaReport.extensions?.phase, "render");
});

test("compose use case blocks failed QA status even when visible issues are warnings", async () => {
  let renderCalled = false;
  const fakeRenderer: PptxRendererPort = {
    async renderPresentation(input) {
      renderCalled = true;
      return {
        pptxBuffer: Buffer.from("fake pptx bytes", "utf8"),
        metadata: {
          engine: "pptxgenjs-native",
          slideCount: input.source.slides.length,
          warnings: [],
        },
      };
    },
  };
  const failedStatusQaValidator = async () => ({
    status: "failed" as const,
    issues: [
      {
        code: "QA_ISSUES_TRUNCATED",
        severity: "warning" as const,
        message: "Additional blocking issues were truncated.",
        path: ["qaReport", "issues"],
      },
    ],
  });
  const composePresentationSource = createComposePresentationSourceUseCase({
    renderer: fakeRenderer,
    qaValidator: failedStatusQaValidator,
  });

  await assert.rejects(
    () => composePresentationSource({
      source: basicProductOverviewFixture,
      failOnQaErrors: true,
    }),
    /Presentation source QA failed/,
  );
  assert.equal(renderCalled, false);
});

test("compose use case renders through real PptxGenJsRendererAdapter with sourceHash", async () => {
  const composePresentationSource = createComposePresentationSourceUseCase({
    renderer: new PptxGenJsRendererAdapter(),
  });

  const result = await composePresentationSource({
    source: basicProductOverviewFixture,
    renderOptions: { sourceHash: "real-adapter-source" },
  });

  assert.ok(Buffer.isBuffer(result.pptxBuffer));
  assert.ok(result.pptxBuffer.byteLength > 1000);
  assert.equal(result.renderMetadata.engine, "pptxgenjs-native");
  assert.equal(result.renderMetadata.slideCount, basicProductOverviewFixture.slides.length);
  assert.equal(result.renderMetadata.sourceHash, "real-adapter-source");
  assert.equal(result.qaReport.status, basicProductOverviewFixture.qaReport.status);
  assert.equal(result.renderQaReport.status, "not_run");
});

test("compose use case returns separate renderQaReport from injected validator", async () => {
  const pptxBuffer = Buffer.from("fake pptx bytes", "utf8");
  const fakeRenderer: PptxRendererPort = {
    async renderPresentation(input) {
      return {
        pptxBuffer,
        metadata: { engine: "pptxgenjs-native", slideCount: input.source.slides.length, warnings: [] },
      };
    },
  };
  const renderQaValidator = async (input: { pptxBuffer: Buffer }) => {
    assert.equal(input.pptxBuffer, pptxBuffer);
    return { status: "passed" as const, issues: [], checkedAtIso: "render-ok", extensions: { phase: "render" } };
  };
  const composePresentationSource = createComposePresentationSourceUseCase({
    renderer: fakeRenderer,
    renderQaValidator,
  });

  const result = await composePresentationSource({ source: basicProductOverviewFixture });

  assert.equal(result.qaReport.status, basicProductOverviewFixture.qaReport.status);
  assert.equal(result.renderQaReport.status, "passed");
  assert.equal(result.renderQaReport.checkedAtIso, "render-ok");
});

test("compose use case blocks failed render QA when requested", async () => {
  const fakeRenderer: PptxRendererPort = {
    async renderPresentation(input) {
      return {
        pptxBuffer: Buffer.from("fake pptx bytes", "utf8"),
        metadata: { engine: "pptxgenjs-native", slideCount: input.source.slides.length, warnings: [] },
      };
    },
  };
  const renderQaValidator = async () => ({
    status: "failed" as const,
    issues: [{ code: "PPTX_PACKAGE_INVALID", severity: "error" as const, message: "Bad package", path: ["pptxBuffer"] }],
    extensions: { phase: "render" },
  });
  const composePresentationSource = createComposePresentationSourceUseCase({ renderer: fakeRenderer, renderQaValidator });

  await assert.rejects(
    () => composePresentationSource({ source: basicProductOverviewFixture, failOnRenderQaErrors: true }),
    /Rendered presentation QA failed/,
  );
});
