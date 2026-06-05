import assert from "node:assert/strict";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { parseOffice } from "officeparser";
import pptxgen from "pptxgenjs";
import { test, vi } from "vitest";
import { createGeneratePptxTool, testExports } from "./generate-pptx-tool";

const artifactStorageMock = vi.hoisted(() => ({
  uploads: [] as Array<{ key: string; body: Buffer; contentType: string }>,
  records: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../storage", () => ({
  buildArtifactStorageKey: (input: { workspaceId: string; artifactId: string; fileName: string }) =>
    `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/${input.fileName}`,
  getContentStorageBucketName: () => "test-bucket",
  uploadArtifactObject: async (input: { key: string; body: Buffer; contentType: string }) => {
    artifactStorageMock.uploads.push(input);
  },
}));

vi.mock("../../artifacts/repository", () => ({
  createSlidesArtifactRecord: async (input: Record<string, unknown>) => {
    artifactStorageMock.records.push(input);
    return { artifactId: input.artifactId, versionId: "version-test" };
  },
}));

test("generate_pptx tool schema can be represented as JSON Schema", () => {
  const jsonSchema = toJsonSchema(testExports.generatePptxSchema);

  assert.equal((jsonSchema as { type?: unknown }).type, "object");
  assert.doesNotThrow(() => JSON.stringify(jsonSchema));
});

test("normalizeDeckSource preserves legacy input without authored fallback copy", () => {
  const source = testExports.normalizeDeckSource({
    title: "AI 产品路演",
    mode: "create",
    brief: "市场机会\n产品方案\n商业模式",
    design: {
      aspectRatio: "16:10",
      stylePreset: "technical",
    },
    rendering: {
      preferHtmlTables: false,
    },
  });

  assert.equal(source.title, "AI 产品路演");
  assert.equal(source.design.aspectRatio, "16:10");
  assert.equal(source.design.language, "auto");
  assert.equal(source.design.resolvedLanguage, "zh");
  assert.equal(source.design.stylePreset, "technical");
  assert.equal(source.rendering.preferHtmlTables, false);
  assert.equal(source.slides.length, 2);
  assert.equal(source.slides[0]?.kind, "title");
  assert.equal(source.slides[1]?.claim, "市场机会");
  assert.deepEqual(source.slides[1]?.body, ["产品方案", "商业模式"]);
});

test("normalizeDeckSpec accepts explicit content and custom design contract", () => {
  const source = testExports.normalizeDeckSource({
    title: "Product Launch Plan",
    mode: "create",
    content: {
      cover: {
        title: "Launch System",
        subtitle: "A focused plan for GTM execution",
        kicker: "Q4 planning",
      },
      narrativeArc: ["Context", "Motion", "Cadence"],
    },
    brief: "Market context",
    design: {
      language: "en",
      stylePreset: "custom",
      customBrief: "Editorial SaaS launch room, high-contrast and compact",
      visualSystem: {
        layoutPrinciples: ["dense comparison pages", "clear section pacing"],
        palette: ["ink", "signal blue", "warm gray"],
        typography: ["strong display headings", "compact body text"],
      },
    },
    slides: [{ kind: "title", claim: "Legacy title" }],
    templateArtifactId: "template-1",
    template: { usage: "layout_reference" },
  });

  assert.equal(source.design.language, "en");
  assert.equal(source.design.resolvedLanguage, "en");
  assert.equal(source.design.stylePreset, "custom");
  assert.equal(source.deckSpec.cover.title, "Launch System");
  assert.equal(source.deckSpec.cover.subtitle, "A focused plan for GTM execution");
  assert.equal(source.deckSpec.cover.kicker, "Q4 planning");
  assert.deepEqual(source.deckSpec.narrativeArc, ["Context", "Motion", "Cadence"]);
  assert.equal(source.deckSpec.design.customBrief, "Editorial SaaS launch room, high-contrast and compact");
  assert.equal(source.deckSpec.design.visualSystem?.palette?.[1], "signal blue");
  assert.equal(source.template.usage, "layout_reference");
});

test("schema repairs leaked JSON in visible text fields before tool validation", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "费曼学习法",
    mode: "create",
    content: {
      cover: {
        title: "费曼学习法",
        subtitle:
          '世界公认高效的学习方法", "kicker": "学习方法论"}, "narrativeArc": ["引入", "定义"]}',
      },
    },
    slides: [
      {
        kind: "content",
        claim:
          '第一步：选择一个概念", "title": "第一步：选择与教授", "kicker": "Concept / Teach"',
        title: "第一步：选择与教授",
      },
    ],
  });
  const source = testExports.normalizeDeckSource(parsed);

  assert.equal(source.deckSpec.cover.subtitle, "世界公认高效的学习方法");
  assert.equal(source.deckSpec.cover.kicker, undefined);
  assert.equal(source.slides[0]?.claim, "第一步：选择一个概念");
});

test("schema repairs missing top-level title and leaked slide JSON in body", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    mode: "create",
    content: {
      cover: {
        title: "费曼学习法",
        subtitle: "用教别人的方式真正学会",
      },
    },
    slides: [
      {
        kind: "title",
        title: "费曼学习法",
        body:
          "世界上最好的学习方法" +
          '"}, {"kind": "content", "intent": "学习金字塔", "title": "学习金字塔", "body": "被动学习 → 主动学习", "layout": {"emphasis": "data"}}, {"kind": "quote", "body": "\\"如果你不能简单解释它，就没有真正理解它。\\"", "layout": {"emphasis": "quote"}}], "slides"',
      },
    ],
  });

  const source = testExports.normalizeDeckSource(parsed);

  assert.equal(parsed.title, "费曼学习法");
  assert.equal(source.slides.length, 3);
  assert.equal(source.slides[0]?.body, "世界上最好的学习方法");
  assert.equal(source.slides[1]?.kind, "content");
  assert.equal(source.slides[1]?.title, "学习金字塔");
  assert.equal(source.slides[1]?.body, "被动学习 → 主动学习");
  assert.deepEqual(source.slides[1]?.layout, { emphasis: "data" });
  assert.equal(source.slides[2]?.kind, "quote");
  assert.equal(
    source.slides[2]?.body,
    '"如果你不能简单解释它，就没有真正理解它。"',
  );
});

test("schema accepts model-authored custom decks with slides nested in content", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    mode: "create",
    generationMode: "visual_html",
    design: {
      language: "zh",
      aspectRatio: "16:9",
      stylePreset: "custom",
      customBrief: "教育类知识分享PPT，风格简洁专业、温暖理性。",
      visualSystem: {
        palette: ["#1a1a2e", "#d4a853", "#f5f0e8"],
        typography: ["标题使用无衬线加粗"],
        layoutPrinciples: ["大面积留白"],
        iconography: "知识图谱风格插画",
      },
      brandMood: "warm academic",
    },
    content: {
      cover: {
        title: "费曼学习法",
        subtitle: "世界上最好的学习法 —— 用输出倒逼输入",
        kicker: "学习方法论",
      },
      narrativeArc: ["引入", "四步拆解", "实践"],
      slides: [
        {
          kind: "title",
          title: "费曼学习法",
          kicker: "学习方法论",
        },
        {
          kind: "content",
          title: "什么是费曼学习法？",
          body: {
            bullets: ["以教代学", "用简单语言讲清概念", "暴露知识盲区"],
          },
        },
      ],
    },
  });
  const source = testExports.normalizeDeckSource(parsed);

  assert.equal(parsed.title, "费曼学习法");
  assert.equal(parsed.content && "slides" in parsed.content, false);
  assert.equal(source.slides.length, 2);
  assert.equal(source.slides[1]?.title, "什么是费曼学习法？");
  assert.equal(source.design.stylePreset, "custom");
});

test("schema normalizes freeform custom style labels and list strings", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "",
    mode: "create",
    content: {
      cover: {
        title: "费曼学习法",
      },
    },
    design: {
      stylePreset: "warm-academic",
      visualSystem: {
        palette: "#FFF8F0, #2B5B84, #F5A623",
        typography: "标题：思源黑体 Bold\n正文：思源宋体 Regular",
        layoutPrinciples: "大量留白；步骤页使用编号；金句页居中",
      },
    },
    slides: [
      {
        kind: "content",
        title: "四步法",
        body: ["选择概念", "教授他人"],
      },
    ],
  });

  assert.equal(parsed.title, "费曼学习法");
  assert.equal(parsed.design?.stylePreset, "custom");
  assert.deepEqual(parsed.design?.visualSystem?.palette, [
    "#FFF8F0",
    "#2B5B84",
    "#F5A623",
  ]);
  assert.equal(parsed.design?.visualSystem?.typography?.length, 2);
  assert.equal(parsed.design?.visualSystem?.layoutPrinciples?.length, 3);
});

test("schema accepts custom visual system v3 fields", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "Custom V3",
    mode: "create",
    design: {
      stylePreset: "custom",
      visualSystem: {
        styleFamily: "education",
        density: "airy",
        geometry: "soft",
        chrome: "lecture",
        illustration: "handdrawn",
        coverTreatment: "lesson board",
        compositionStyle: "notebook",
        backgroundTreatment: "paper",
        motifs: ["soft blue lines", "handdrawn arrows"],
        layoutPolicy: {
          strict: true,
          diversity: "high",
        },
      },
    },
    slides: [
      { kind: "title", title: "Custom V3" },
      { kind: "content", title: "One point", body: ["Detail"] },
    ],
  });

  assert.equal(parsed.design?.visualSystem?.styleFamily, "education");
  assert.equal(parsed.design?.visualSystem?.density, "airy");
  assert.equal(parsed.design?.visualSystem?.geometry, "soft");
  assert.equal(parsed.design?.visualSystem?.chrome, "lecture");
  assert.equal(parsed.design?.visualSystem?.illustration, "handdrawn");
  assert.equal(parsed.design?.visualSystem?.coverTreatment, "lesson board");
  assert.equal(parsed.design?.visualSystem?.compositionStyle, "notebook");
  assert.equal(parsed.design?.visualSystem?.backgroundTreatment, "paper");
  assert.deepEqual(parsed.design?.visualSystem?.motifs, [
    "soft blue lines",
    "handdrawn arrows",
  ]);
  assert.equal(parsed.design?.visualSystem?.layoutPolicy?.strict, true);
  assert.equal(parsed.design?.visualSystem?.layoutPolicy?.diversity, "high");
});

test("schema tolerates unknown custom visual system tokens", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "Loose Visual System",
    mode: "create",
    design: {
      stylePreset: "custom",
      visualSystem: {
        styleFamily: "education",
        compositionStyle: "floating notebook collage",
        backgroundTreatment: "chalk wash",
      },
    },
    slides: [
      { kind: "title", title: "Loose Visual System" },
      { kind: "content", title: "One point", body: ["Detail"] },
    ],
  });

  assert.equal(parsed.design?.visualSystem?.styleFamily, "education");
  assert.equal(parsed.design?.visualSystem?.compositionStyle, undefined);
  assert.equal(parsed.design?.visualSystem?.backgroundTreatment, undefined);
});

test("schema truncates overlong visible text instead of rejecting the tool call", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "费曼学习法",
    mode: "create",
    content: {
      cover: {
        subtitle: "学".repeat(700),
      },
    },
  });

  assert.equal(parsed.content?.cover?.subtitle?.length, 500);
});

test("schema accepts slides without claim and normalizes from title", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "费曼学习法",
    mode: "create",
    slides: [
      {
        kind: "content",
        title: "四步掌握复杂概念",
        body: ["选择概念", "教给别人", "发现缺口", "简化表达"],
      },
    ],
  });
  const source = testExports.normalizeDeckSource(parsed);

  assert.equal(source.slides[0]?.claim, "四步掌握复杂概念");
  assert.match(
    source.normalizationWarnings.join("\n"),
    /slide_1_claim_missing_normalized/,
  );
});

test("authored deck content gate rejects title-only input", () => {
  assert.equal(
    testExports.hasSufficientAuthoredDeckContent({
      title: "费曼学习法",
      mode: "create",
    }),
    false,
  );
});

test("authored deck content gate accepts multiple explicit slides", () => {
  assert.equal(
    testExports.hasSufficientAuthoredDeckContent({
      title: "费曼学习法",
      mode: "create",
      slides: [
        { kind: "title", title: "用教别人的方式真正学会" },
        {
          kind: "content",
          title: "四步掌握复杂概念",
          body: ["选择概念", "教给别人", "发现缺口", "简化表达"],
        },
      ],
    }),
    true,
  );
});

test("authored deck content gate rejects title-only slide outlines", () => {
  assert.equal(
    testExports.hasSufficientAuthoredDeckContent({
      title: "费曼学习法",
      mode: "create",
      slides: [
        { kind: "title", title: "用教别人的方式真正学会" },
        { kind: "content", title: "四步掌握复杂概念" },
      ],
    }),
    false,
  );
});

test("authored deck content gate accepts structured brief fallback", () => {
  assert.equal(
    testExports.hasSufficientAuthoredDeckContent({
      title: "费曼学习法",
      mode: "create",
      brief: "选择概念\n教给别人\n发现缺口\n简化表达",
    }),
    true,
  );
});

test("buildQaWarnings flags missing image assets", () => {
  const source = testExports.normalizeDeckSource({
    title: "Deck",
    mode: "create",
    slides: [
      {
        kind: "image",
        claim: "产品界面需要一张可检查的截图",
      },
    ],
  });

  const warnings = testExports.buildQaWarnings({
    source,
    output: {},
  });

  assert.match(warnings.join("\n"), /image_missing/);
});

test("normalizeDeckSource normalizes empty claims to deck title and records QA warning", () => {
  const parsed = testExports.parseGeneratePptxArgs({
    title: "费曼学习法：用教别人的方式真正学会",
    mode: "create",
    design: {
      language: "zh",
      aspectRatio: "16:9",
      stylePreset: "executive",
    },
    slides: [
      {
        kind: "quote",
        claim: "",
        body: {
          text: "学习不是把知识塞进脑子里，而是把知识从脑子里倒出来。",
        },
      },
    ],
  });
  const source = testExports.normalizeDeckSource(parsed);
  const warnings = testExports.buildQaWarnings({
    source,
    output: parsed.output,
  });

  assert.equal(source.slides[0]?.claim, "费曼学习法：用教别人的方式真正学会");
  assert.equal(source.design.resolvedLanguage, "zh");
  assert.match(warnings.join("\n"), /slide_1_claim_missing_normalized/);
});

test("normalizes table rows and chart data", () => {
  assert.deepEqual(
    testExports.normalizeRows({
      rows: [
        ["Metric", "Value"],
        ["ARR", 12],
      ],
    }),
    [
      ["Metric", "Value"],
      ["ARR", "12"],
    ],
  );

  assert.deepEqual(
    testExports.normalizeChartData({
      data: [
        { name: "A", value: 1 },
        { name: "bad", value: "x" },
      ],
    }),
    [{ name: "A", value: 1 }],
  );
});


test("legacy visual_html mode normalizes to high_quality_editable_pptx route", () => {
  const route = testExports.normalizePptxGenerationRoute({
    generationMode: "visual_html",
  });

  assert.equal(route.artifactGenerationMode, "editable_native");
  assert.equal(route.internalGenerationMode, "high_quality_editable_pptx");
  assert.equal(route.legacyGenerationMode, "visual_html");
  assert.equal(route.normalizedFromLegacyMode, true);
  assert.match(route.warnings.join("\n"), /legacy_generation_mode_normalized/);
});

test("omitted generationMode defaults to native editable PPTX composer route", () => {
  const route = testExports.normalizePptxGenerationRoute({});

  assert.equal(route.artifactGenerationMode, "editable_native");
  assert.equal(route.internalGenerationMode, "high_quality_editable_pptx");
  assert.equal(route.legacyGenerationMode, "editable_native");
  assert.equal(route.normalizedFromLegacyMode, false);
  assert.deepEqual(route.warnings, []);
});

test("PPTX runtime prompt advertises unified composer route", () => {
  const lines = testExports.buildPptxRuntimePromptLines({
    pptxSelection: { generationMode: "visual_html" },
  });
  const text = lines.join("\n");

  assert.match(text, /high_quality_editable_pptx/);
  assert.match(text, /Legacy generation mode requested: visual_html/);
  assert.doesNotMatch(text, /browser-side PPTX export/);
});



test("generate_pptx persists composer pptx source and qa metadata", () => {
  const legacySource = testExports.normalizeDeckSource({
    title: "Composer Metadata Deck",
    mode: "create",
    brief: "Explain why metadata survives artifact persistence.",
    content: {
      cover: {
        title: "Composer Metadata Deck",
        subtitle: "Persist native PPTX metadata safely",
      },
      narrativeArc: ["Need", "Path", "Proof"],
    },
    output: { includeSourceJson: true },
    slides: [
      { kind: "title", claim: "Composer Metadata Deck" },
      { kind: "content", claim: "Metadata is structured", body: ["PPTX URL", "Source JSON URL", "QA summary"] },
      { kind: "closing", claim: "Persist only safe metadata", body: ["Redact secrets", "Keep render references"] },
    ],
  });

  const composerSource = testExports.deckSourceToComposerSource(legacySource);
  const metadata = testExports.summarizeComposerMetadata({
    renderMetadata: {
      engine: "pptxgenjs-native",
      sourceHash: "source-hash-1",
      slideCount: composerSource.slides.length,
      editableCompatibility: "native-v1",
      editablePrimitiveCountsBySlide: [
        { slideId: "slide-1", textBoxes: 3, shapes: 1, images: 0, tables: 0, charts: 0 },
      ],
      warnings: [],
    },
    qaReport: { status: "passed", issues: [] },
    renderQaReport: { status: "passed", issues: [] },
  });
  const result = testExports.formatToolResult({
    artifactId: "artifact-1",
    artifactUrl: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    editable: true,
    fileName: "composer-metadata-deck.pptx",
    generationMode: "editable_native",
    previewRenderer: "pptxviewjs",
    pptxUrl: "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    qaSummary: "Passed v1 structural QA.",
    slideCount: composerSource.slides.length,
    sourceJsonUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
    title: "Composer Metadata Deck",
    versionId: "version-1",
    warnings: [],
    renderMetadata: metadata.renderMetadata,
    qaReportSummary: metadata.qaSummary,
  });

  assert.equal(composerSource.schemaVersion, "pptx-composer.v1");
  assert.equal(composerSource.slides.length, 3);
  assert.equal(composerSource.renderMetadata, undefined);
  assert.equal(result.type, "presentation_artifact_result");
  assert.equal(result.pptx_url, "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1");
  assert.equal(result.source_json_url, "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json");
  assert.deepEqual(result.qa_report_summary, { status: "passed", issueCount: 0, issueCounts: {} });
  assert.equal(result.render_metadata?.engine, "pptxgenjs-native");
  assert.equal(result.render_metadata?.editableCompatibility, "native-v1");
  assert.equal(result.render_metadata?.sourceHash, "source-hash-1");
});

test("composer render metadata redacts secret-like values", () => {
  const redacted = testExports.redactSecretLikeMetadata({
    engine: "pptxgenjs-native",
    sourceHash: "safe-hash",
    authHeader: "Bearer abc123",
    nested: {
      api_key: "open-secret",
      token: "sk-test-123",
      safe: "visible-reference",
    },
    warnings: ["ok", "contains sk-hidden value"],
  });
  const serialized = JSON.stringify(redacted);

  assert.equal((redacted as { nested: { safe: string } }).nested.safe, "visible-reference");
  assert.doesNotMatch(serialized, /sk-test-123|sk-hidden|Bearer abc123|open-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("composer emits minimal observability metadata", () => {
  const source = testExports.normalizeDeckSource({
    title: "Observability Deck",
    mode: "create",
    design: { language: "en", stylePreset: "technical" },
    slides: [
      { kind: "title", claim: "Observability Deck" },
      { kind: "content", claim: "Signals stay compact", body: ["Layout IDs", "QA counts", "Warnings"] },
    ],
  });
  const composerSource = testExports.deckSourceToComposerSource(source);
  const metadata = testExports.summarizeComposerMetadata({
    renderMetadata: {
      engine: "pptxgenjs-native",
      sourceHash: "source-hash-1",
      slideCount: composerSource.slides.length,
      editableCompatibility: "native-v1",
      warnings: ["render_warning: safe detail"],
    },
    qaReport: {
      status: "failed",
      issues: [
        { code: "CONTENT_TOO_DENSE", severity: "error", message: "Too dense", path: [] },
      ],
    },
    renderQaReport: {
      status: "passed",
      issues: [
        { code: "PLACEHOLDER_TEXT_PRESENT", severity: "warning", message: "Placeholder", path: [] },
      ],
    },
  });

  const observability = testExports.buildComposerObservabilityMetadata({
    artifactId: "artifact-1",
    artifactRefs: { pptx: "artifact-1", sourceJson: "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json" },
    composerSource,
    generationId: "generation-1",
    metadata,
    renderDurationMs: 42,
    repairAttemptCount: 1,
    warnings: ["custom_visual_system_native_limited: normalized"],
  });

  assert.equal(observability.schemaVersion, "pptx-composer.observability.v1");
  assert.equal(observability.generationId, "generation-1");
  assert.equal(observability.artifactId, "artifact-1");
  assert.equal(observability.sourceSchemaVersion, "pptx-composer.v1");
  assert.deepEqual(observability.selectedVisualSystem, {
    designName: composerSource.designSystem.name,
    density: composerSource.designSystem.density,
    aspectRatio: "16:9",
    language: "en",
  });
  assert.deepEqual(observability.layoutIds, composerSource.slides.map((slide) => slide.layoutSpec.name));
  assert.deepEqual(observability.qaFailureCounts, { preRender: 1, render: 0, total: 1 });
  assert.equal(observability.repairAttemptCount, 1);
  assert.equal(observability.renderDurationMs, 42);
  assert.deepEqual(observability.artifactRefs, {
    pptx: "artifact-1",
    sourceJson: "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
  });
  assert.deepEqual(observability.warningCodes, [
    "custom_visual_system_native_limited",
    "render_warning",
    "CONTENT_TOO_DENSE",
    "PLACEHOLDER_TEXT_PRESENT",
  ]);
});

test("composer observability metadata redacts sensitive values", () => {
  const source = testExports.normalizeDeckSource({
    title: "Sensitive Metadata Deck",
    mode: "create",
    brief: "RAW BRIEF sk-brief-secret Bearer prompt-token api_key prompt-secret",
    design: {
      language: "en",
      stylePreset: "custom",
      customBrief: "Hidden prompt text with sk-custom-secret",
    },
    slides: [
      { kind: "title", claim: "Sensitive Metadata Deck" },
      { kind: "content", claim: "Safe summary", body: ["No prompts", "No secrets"] },
    ],
  });
  const composerSource = testExports.deckSourceToComposerSource(source);
  const metadata = testExports.summarizeComposerMetadata({
    renderMetadata: {
      engine: "pptxgenjs-native",
      sourceHash: "source-hash-1",
      slideCount: composerSource.slides.length,
      warnings: ["Bearer render-secret", "api_key render-secret"],
      extensions: {
        api_key: "open-secret",
        nested: ["sk-nested-secret"],
      },
    },
    qaReport: {
      status: "passed",
      issues: [
        { code: "Bearer qa-secret", severity: "warning", message: "sk-message-secret", path: [] },
      ],
    },
    renderQaReport: { status: "passed", issues: [] },
  });

  const observability = testExports.buildComposerObservabilityMetadata({
    artifactId: "artifact-1",
    artifactRefs: { pptx: "artifact-1", api_key: "artifact-secret" },
    composerSource,
    generationId: "generation-1",
    metadata,
    renderDurationMs: 7,
    warnings: ["Bearer warning-secret", "api_key warning-secret", "safe_warning: ok"],
  });
  const serialized = JSON.stringify(observability);

  assert.doesNotMatch(serialized, /RAW BRIEF|Hidden prompt text|sourceSummary|contentBrief|requirementAnalysis/);
  assert.doesNotMatch(serialized, /sk-brief-secret|Bearer prompt-token|prompt-secret|sk-custom-secret/);
  assert.doesNotMatch(serialized, /open-secret|sk-nested-secret|artifact-secret|render-secret|qa-secret|message-secret|warning-secret/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.deepEqual(observability.warningCodes, ["[REDACTED]", "safe_warning"]);
});

test("formatToolResult returns structured artifact metadata with clean content", () => {
  const result = testExports.formatToolResult({
    artifactId: "artifact-1",
    artifactUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    editable: true,
    fileName: "feynman.pptx",
    generationMode: "editable_native",
    previewRenderer: "pptxviewjs",
    pptxUrl:
      "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    qaSummary: "Passed v1 structural QA.",
    slideCount: 12,
    sourceJsonUrl:
      "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
    title: "费曼学习法",
    versionId: "version-1",
    warnings: [],
  });

  assert.equal(result.artifact_id, "artifact-1");
  assert.equal(
    result.artifact_url,
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
  assert.equal(result.file_name, "feynman.pptx");
  assert.equal(result.generation_mode, "editable_native");
  assert.equal(result.internal_generation_mode, undefined);
  assert.equal(result.legacy_generation_mode, undefined);
  assert.equal(result.preview_renderer, "pptxviewjs");
  assert.equal(result.editable, true);
  assert.equal(result.slide_count, 12);
  assert.equal(
    result.source_json_url,
    "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
  );
  assert.doesNotMatch(result.content, /artifact-1/);
  assert.doesNotMatch(result.content, /\/v1\/workspaces/);
});

async function callGeneratePptxTool(input: {
  args?: Record<string, unknown>;
  toolCallId?: string;
  writer?: (event: Record<string, unknown>) => void;
}) {
  artifactStorageMock.uploads.length = 0;
  artifactStorageMock.records.length = 0;
  const generatePptxTool = createGeneratePptxTool({
    teamId: "team-test",
    workspaceId: "workspace-test",
    threadId: "thread-test",
    userId: "user-test",
    userMessageId: "message-test",
  });
  const args = input.args ?? {
    title: "Composer Runtime Deck",
    mode: "create" as const,
    content: {
      cover: {
        title: "Composer Runtime Deck",
        subtitle: "Native editable PPTX from composer",
        kicker: "Task 16",
      },
      narrativeArc: ["Promise", "Proof"],
    },
    slides: [
      {
        kind: "title" as const,
        claim: "Composer Runtime Deck",
        body: ["Native editable objects", "Composer route"],
      },
      {
        kind: "content" as const,
        claim: "Composer creates the default artifact",
        body: ["Plan the deck", "Render native shapes", "Persist the PPTX"],
      },
    ],
    design: { language: "en" as const, stylePreset: "executive" as const },
    output: { includeSourceJson: true },
  };

  type ToolArgs = typeof args;
  return (generatePptxTool as unknown as {
    func: (
      args: ToolArgs,
      runManager: { getChild(): undefined },
      config: { toolCallId?: string; writer?: (event: Record<string, unknown>) => void },
    ) => Promise<Record<string, unknown>>;
  }).func(args, { getChild: () => undefined }, {
    toolCallId: input.toolCallId,
    writer: input.writer,
  });
}

test("generate_pptx redacts persisted source JSON secrets", async () => {
  await callGeneratePptxTool({
    args: {
      title: "Sensitive Source Deck",
      mode: "create",
      brief: "Source summary with sk-brief-secret and Bearer brief-token",
      content: {
        cover: {
          title: "Sensitive Source Deck",
          subtitle: "Bearer subtitle-token",
        },
        narrativeArc: ["Keep sk-arc-secret hidden", "Show safe structure"],
      },
      slides: [
        {
          kind: "title",
          claim: "Sensitive Source Deck",
          body: ["Bearer body-token", "Visible safe body"],
          notes: "speaker note sk-note-secret",
        },
        {
          kind: "content",
          claim: "api_key claim-secret",
          body: {
            bullets: ["safe bullet", "sk-bullet-secret"],
            api_key: "nested-body-secret",
          },
        },
      ],
      design: {
        language: "en",
        stylePreset: "custom",
        customBrief: "Brand note Bearer custom-token",
        visualSystem: {
          layoutPrinciples: ["api_key layout-secret", "safe layout"],
        },
      },
      assets: {
        imageArtifactIds: ["sk-asset-secret"],
        api_key: "asset-object-secret",
      },
      output: { includeSourceJson: true },
    },
  });
  const sourceUpload = artifactStorageMock.uploads.find((upload) => upload.key.endsWith("/deck.source.json"));
  const payload = artifactStorageMock.records[0]?.payload as Record<string, unknown>;
  const uploadedSource = sourceUpload?.body.toString("utf8") ?? "";

  assert.ok(sourceUpload, "expected source JSON upload");
  assert.equal(payload.sourceJson, undefined);
  assert.ok(payload.sourceJsonStorageKey, "expected source JSON storage metadata");
  assert.doesNotMatch(
    uploadedSource,
    /sk-brief-secret|Bearer brief-token|subtitle-token|sk-arc-secret|body-token|sk-note-secret|claim-secret|sk-bullet-secret|nested-body-secret|custom-token|layout-secret|sk-asset-secret|asset-object-secret/,
  );
  assert.match(uploadedSource, /\[REDACTED\]/);
});

test("generate_pptx default composer result is pptx artifact", async () => {
  const result = await callGeneratePptxTool({ toolCallId: "tool-call-result" });
  const pptxUpload = artifactStorageMock.uploads.find((upload) =>
    upload.contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  const sourceUpload = artifactStorageMock.uploads.find((upload) =>
    upload.contentType === "application/json"
  );
  const payload = artifactStorageMock.records[0]?.payload as Record<string, unknown>;

  assert.equal(result.type, "presentation_artifact_result");
  assert.match(String(result.file_name), /\.pptx$/);
  assert.equal(result.generation_mode, "editable_native");
  assert.equal(result.internal_generation_mode, "high_quality_editable_pptx");
  assert.equal(result.legacy_generation_mode, "editable_native");
  assert.equal(result.preview_renderer, "pptxviewjs");
  assert.equal(result.editable, true);
  assert.equal(result.pptx_url, result.artifact_url);
  assert.ok(result.render_metadata);
  assert.ok(result.qa_report_summary);
  assert.ok(result.composer_observability_metadata);
  assert.ok(pptxUpload, "expected a PPTX upload");
  assert.equal(pptxUpload?.body.subarray(0, 2).toString("utf8"), "PK");
  assert.ok(sourceUpload, "expected composer source JSON upload");
  assert.equal(payload.generationMode, "editable_native");
  assert.equal(payload.internalGenerationMode, "high_quality_editable_pptx");
  assert.equal(payload.previewRenderer, "pptxviewjs");
  assert.ok(payload.composerObservabilityMetadata);
  assert.equal(
    (payload.composerObservabilityMetadata as Record<string, unknown>).sourceSchemaVersion,
    "pptx-composer.v1",
  );
});

test("generate_pptx returns input-required result when composer source QA fails", async () => {
  const result = await callGeneratePptxTool({
    args: {
      title: "QA Failure Deck",
      mode: "create",
      content: {
        cover: {
          title: "QA Failure Deck",
          subtitle: "Exercise tool-level QA failure handling",
        },
        narrativeArc: ["Setup", "Proof"],
      },
      slides: [
        {
          kind: "title",
          claim: "QA Failure Deck",
          body: ["Exercise tool-level QA failure handling"],
        },
        {
          kind: "content",
          claim: "One-column content should not crash the worker",
          body: ["Only one required column is filled"],
        },
      ],
      design: { language: "en", stylePreset: "executive" },
    },
    toolCallId: "tool-call-qa-failure",
  });

  assert.equal(result.type, "presentation_artifact_input_required");
  assert.equal(result.status, "needs_content");
  assert.equal(result.composer_qa_phase, "source");
  assert.equal((result.qa_report_summary as Record<string, unknown>).status, "failed");
  assert.match(String(result.content), /presentation source QA failed/i);
  assert.match(JSON.stringify(result.warnings), /REQUIRED_SLOT_EMPTY/);
  assert.equal(artifactStorageMock.uploads.length, 0);
  assert.equal(artifactStorageMock.records.length, 0);
});

test("generate_pptx composer emits planning generating saving ready stages", async () => {
  const events: Array<Record<string, unknown>> = [];
  await callGeneratePptxTool({
    toolCallId: "tool-call-progress",
    writer: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map((event) => event.stage),
    ["planning", "generating", "saving", "ready"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    Array.from({ length: 4 }, () => "generate_pptx_progress"),
  );
  assert.deepEqual(
    events.map((event) => event.toolCallId),
    Array.from({ length: 4 }, () => "tool-call-progress"),
  );
  assert.equal(events[0]?.internalGenerationMode, "high_quality_editable_pptx");
  assert.match(String(events[2]?.fileName), /\.pptx$/);
  assert.equal(events[3]?.pptxUrl, events[3]?.artifactUrl);
  assert.ok(events[3]?.composerObservabilityMetadata);
});

test("buildVisualHtml returns an HTML deck with slide sections", () => {
  const source = testExports.normalizeDeckSource({
    title: "Visual Deck",
    mode: "create",
    slides: [
      { kind: "title", claim: "Visual Deck" },
      { kind: "content", claim: "Big point", body: ["One", "Two"] },
    ],
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.match(html, /data-sourceweft-deck="visual_html"/);
  assert.match(html, /data-sourceweft-fonts="/);
  assert.match(html, /font-display: block/);
  assert.match(html, /https:\/\/assets\.sourceweft\.com\/fonts\/inter\/Inter-29160a80ff49ddca\.ttf/);
  assert.match(html, /rel="preload"/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /raw\.githubusercontent\.com\/google\/fonts/);
  assert.match(html, /body\.sw-export \*, body\.sw-export \*::before/);
  assert.doesNotMatch(html, /body\.sw-export \.sw-slide::before/);
  assert.doesNotMatch(html, /rect\.width - 24/);
  assert.match(html, /rect\.width \/ w/);
  assert.match(html, /Math\.max\(0, \(rect\.width - w \* safeScale\) \/ 2\)/);
  assert.match(html, /class="sw-slide slide-title/);
  assert.match(html, /Big point/);
});

test("visual renderer uses explicit DeckSpec slots and no design metadata copy", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    content: {
      cover: {
        title: "用教别人的方式真正学会",
        subtitle: "费曼学习法的四步实践路径",
        kicker: "学习方法工作坊",
      },
      narrativeArc: ["问题", "方法", "练习"],
    },
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "用教别人的方式检验理解",
        title: "输出暴露理解缺口",
        kicker: "步骤 01",
        body: ["选择一个概念", "用自己的话解释", "发现知识缺口"],
        footer: "练习时长：15 分钟",
      },
      {
        kind: "image",
        claim: "把抽象学习过程变成可视化路径",
        caption: "解释、反馈、补漏、再表达",
      },
    ],
    design: {
      aspectRatio: "16:9",
      language: "zh",
      stylePreset: "editorial",
      customBrief: "Do not render this custom brief as slide copy",
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.match(html, /data-sourceweft-aspect="16:9"/);
  assert.match(html, /用教别人的方式真正学会/);
  assert.match(html, /费曼学习法的四步实践路径/);
  assert.match(html, /学习方法工作坊/);
  assert.match(html, /输出暴露理解缺口/);
  assert.match(html, /步骤 01/);
  assert.match(html, /练习时长：15 分钟/);
  assert.match(html, /解释、反馈、补漏、再表达/);
  assert.doesNotMatch(html, />Editorial</);
  assert.doesNotMatch(html, />16:9 visual deck</);
  assert.doesNotMatch(html, />editorial</);
  assert.doesNotMatch(html, /Do not render this custom brief/);
});

test("visual renderer leaves missing slots empty without fallback copy", () => {
  const source = testExports.normalizeDeckSource({
    title: "Empty Slots",
    mode: "create",
    design: {
      aspectRatio: "16:9",
      stylePreset: "custom",
      customBrief: "Warm lab notebook with dense diagrams",
    },
    slides: [
      { kind: "title", claim: "Empty Slots" },
      { kind: "chart", claim: "No fake chart" },
      { kind: "table", claim: "No fake table" },
      { kind: "image", claim: "No fake caption" },
      { kind: "quote", claim: "No fake quote" },
    ],
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.match(html, /<h1[^>]*>Empty Slots<\/h1>/);
  assert.doesNotMatch(html, /Warm lab notebook/);
  assert.doesNotMatch(html, /Dimension|Current|Baseline|Option A|Option B/);
  assert.doesNotMatch(html, /Visual slide can carry|Quote or key voice/);
  assert.doesNotMatch(html, /class="subtitle"/);
  assert.doesNotMatch(html, /class="eyebrow"/);
});

test("visual renderer allows user-authored metadata words in content", () => {
  const source = testExports.normalizeDeckSource({
    title: "Magazine System",
    mode: "create",
    slides: [
      { kind: "title", claim: "Magazine System" },
      {
        kind: "content",
        claim: "Editorial design style should guide the reading rhythm",
        body: ["Use a 16:9 canvas for classroom projection."],
      },
    ],
    design: {
      aspectRatio: "16:9",
      language: "en",
      stylePreset: "editorial",
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.match(html, /Editorial design style should guide the reading rhythm/);
  assert.match(html, /Use a 16:9 canvas for classroom projection/);
});

test("visual renderer applies custom visual system instead of fixed custom preset", () => {
  const source = testExports.normalizeDeckSource({
    title: "Custom System",
    mode: "create",
    content: {
      cover: {
        title: "Custom System",
        subtitle: "A generated visual identity should drive the deck.",
      },
    },
    slides: [
      { kind: "title", claim: "Custom System" },
      {
        kind: "content",
        claim: "The renderer should use the authored design system",
        body: ["Palette, typography, and layout come from the tool args."],
      },
    ],
    design: {
      language: "en",
      stylePreset: "custom",
      customBrief: "Technical blueprint grid with serif display contrast",
      visualSystem: {
        palette: ["#101820", "#F2AA4C", "#E8F1F2"],
        typography: ["serif display heading", "compact sans body"],
        layoutPrinciples: ["technical blueprint grid", "sharp card geometry"],
      },
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.match(html, /data-sourceweft-style="custom"/);
  assert.match(html, /data-sourceweft-family="blueprint"/);
  assert.match(html, /data-layout="blueprint-cover"/);
  assert.match(html, /data-cover-treatment="schematic-title"/);
  assert.match(html, /data-sourceweft-scene-id="visual-scene-1"/);
  assert.match(html, /--bg: #E8F1F2/);
  assert.match(html, /--text: #101820/);
  assert.match(html, /--accent: #F2AA4C/);
  assert.match(html, /--card-radius: 2px/);
  assert.match(html, /--font-heading: "Noto Serif"/);
  assert.doesNotMatch(html, /--accent: #334155/);
  assert.doesNotMatch(html, /Technical blueprint grid/);
});

test("custom education visual system compiles to registered education layouts", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    content: {
      cover: {
        title: "费曼学习法",
        subtitle: "用输出倒逼输入",
        kicker: "学习方法论",
      },
    },
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "四步把复杂概念讲清楚",
        layout: { pattern: "step-board", emphasis: "process" },
        body: ["选择一个概念", "教给别人", "发现缺口", "简化表达"],
      },
      {
        kind: "closing",
        claim: "真正学会，是能用自己的话复述",
        body: ["今天选一个概念，讲给一个真实的人听。"],
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      customBrief: "暖白、柔和蓝、手绘感、教育风格，适合课堂投屏。",
      visualSystem: {
        styleFamily: "education",
        geometry: "soft",
        chrome: "lecture",
        illustration: "handdrawn",
        palette: ["暖白", "柔和蓝", "#2F4858"],
      },
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.match(html, /data-sourceweft-family="education"/);
  assert.match(html, /data-cover-treatment="notebook-map"/);
  assert.match(html, /data-sourceweft-chrome="lecture"/);
  assert.match(html, /data-sourceweft-illustration="handdrawn"/);
  assert.match(html, /data-layout="education-cover"/);
  assert.match(html, /data-layout="education-step-board"/);
  assert.match(html, /data-layout="education-summary"/);
  assert.match(html, /education-step-board/);
  assert.match(html, /cover-education cover-notebook-map/);
  assert.doesNotMatch(html, /class="title-frame"/);
  assert.doesNotMatch(html, /暖白、柔和蓝、手绘感/);
});

test("custom education decks stay controlled without unrequested cover diagrams", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    content: {
      cover: {
        title: "费曼学习法",
        subtitle: "用教别人的方式真正学会",
        kicker: "学习方法论",
      },
    },
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "不止是物理学天才",
        body: [
          "理查德·费曼是美国理论物理学家，但他真正的超能力，是用最简单的语言向任何人解释最复杂的概念。",
        ],
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      customBrief: "高端教育风，温暖、清晰、适合课堂投屏。",
      visualSystem: {
        styleFamily: "education",
        density: "balanced",
        geometry: "soft",
      },
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");
  const metadata = testExports.extractVisualDeckMetadata(source);

  assert.match(html, /data-sourceweft-family="education"/);
  assert.match(html, /data-cover-treatment="lesson-board"/);
  assert.doesNotMatch(html, /data-node-kind="diagram"/);
  assert.doesNotMatch(html, /data-node-kind="shape"/);
  assert.doesNotMatch(html, /data-node-role="notebook"/);
  assert.equal(metadata.compiledVisualSystem.illustration, "none");
  assert.doesNotMatch(
    metadata.qaWarnings.join("\n"),
    /visual_cover_unrequested_decoration/,
  );
});

test("education long single bullets compile to paragraph layout instead of sparse concept cards", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "第一步：确定学习目标",
        body: [
          "选择一个你想要深入理解的概念或知识领域，把它写在一张白纸的顶端。不要满足于知道名字，要先建立初步理解，然后立刻进入讲解。",
        ],
      },
      {
        kind: "content",
        claim: "第二步：用最简单的话讲给别人听",
        body: [
          "假设你在给一个十二岁的孩子讲解，放弃专业术语，只用自己的语言组织知识。如果讲得磕磕绊绊，说明理解还有空洞。",
        ],
      },
      {
        kind: "content",
        claim: "第三步：发现缺口，回到源头",
        body: [
          "讲解过程中卡住的地方，就是你没有真正理解的地方。回到学习材料，针对性补上知识缺口，再重新解释一次。",
        ],
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      customBrief: "教育风，干净清晰。",
      visualSystem: { styleFamily: "education" },
    },
  });

  const metadata = testExports.extractVisualDeckMetadata(source);
  const html = testExports.buildVisualHtml(source).toString("utf8");
  const bodyLayouts = metadata.resolvedLayouts.slice(1).map((layout) => ({
    id: layout.layoutId,
    macro: layout.macroLayout,
    shape: layout.contentShape,
  }));

  assert.deepEqual(
    bodyLayouts.map((layout) => layout.shape),
    ["paragraph", "paragraph", "paragraph"],
  );
  assert.doesNotMatch(
    bodyLayouts.map((layout) => layout.id).join("\n"),
    /education-concept-map/,
  );
  assert.match(html, /class="paragraph-panel"/);
  assert.doesNotMatch(
    metadata.qaWarnings.join("\n"),
    /visual_sparse_card_layout|visual_layout_repetition/,
  );
});

test("Chinese deck visible copy strips leaked English planning fragments", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "第一步：确定学习目标",
        body: [
          "选择一个你想要深入理解的概念或知识领域。不要on opener for the four-step method",
        ],
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      visualSystem: { styleFamily: "education" },
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");
  const warnings = testExports.buildQaWarnings({
    generationMode: "visual_html",
    source,
    output: {},
  });

  assert.doesNotMatch(html, /opener|four-step method/);
  assert.doesNotMatch(warnings.join("\n"), /visible_language_pollution/);
});

test("education intent overrides accidental editorial family unless explicitly requested", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "实际应用场景",
        body: {
          bullets: [
            "学生备考：用费曼法复习知识点",
            "职场学习：学习新工具时快速上手",
            "写作演讲：梳理表达结构",
            "日常阅读：读完后讲给朋友听",
            "编程学习：用大白话解释算法",
          ],
        },
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      customBrief: "教育学习主题，温暖专业，适合教学培训场景。",
      visualSystem: {
        styleFamily: "editorial",
        density: "balanced",
        geometry: "soft",
      },
    },
  });

  const metadata = testExports.extractVisualDeckMetadata(source);
  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.equal(metadata.compiledVisualSystem.family, "education");
  assert.match(html, /data-sourceweft-family="education"/);
  assert.equal(metadata.resolvedLayouts[1]?.layoutId, "education-concept-map");
  assert.doesNotMatch(
    metadata.qaWarnings.join("\n"),
    /visual_shape_layout_mismatch|visual_layout_repetition/,
  );
});

test("explicit editorial request keeps editorial family but card content avoids longform", () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "实际应用场景",
        body: {
          bullets: [
            "学生备考：用费曼法复习知识点",
            "职场学习：学习新工具时快速上手",
            "写作演讲：梳理表达结构",
            "日常阅读：读完后讲给朋友听",
            "编程学习：用大白话解释算法",
          ],
        },
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      customBrief: "教育学习主题，但请做成明确的杂志风 editorial 视觉。",
      visualSystem: {
        styleFamily: "editorial",
      },
    },
  });

  const metadata = testExports.extractVisualDeckMetadata(source);
  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.equal(metadata.compiledVisualSystem.family, "editorial");
  assert.equal(metadata.resolvedLayouts[1]?.contentShape, "cards");
  assert.equal(metadata.resolvedLayouts[1]?.layoutId, "editorial-cards");
  assert.equal(metadata.resolvedLayouts[1]?.macroLayout, "cards");
  assert.doesNotMatch(html, /data-layout="editorial-longform"[^>]*实际应用场景/);
  assert.doesNotMatch(
    metadata.qaWarnings.join("\n"),
    /visual_shape_layout_mismatch/,
  );
});

test("visual html renderer does not emit empty bullet grids", () => {
  const source = testExports.normalizeDeckSource({
    title: "空内容防护",
    mode: "create",
    slides: [
      { kind: "title", claim: "空内容防护" },
      {
        kind: "content",
        claim: "只有标题时转为章节",
        body: [],
      },
    ],
    design: {
      language: "zh",
      stylePreset: "custom",
      visualSystem: { styleFamily: "education" },
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.doesNotMatch(html, /<div class="bullet-grid[^"]*"><\/div>/);
  assert.doesNotMatch(html, /data-kind="content"/);
  assert.match(html, /data-kind="section"/);
});

test("visual layout QA blocks card grids mapped into longform", () => {
  const source = testExports.normalizeDeckSource({
    title: "Longform mismatch",
    mode: "create",
    slides: [
      { kind: "title", claim: "Longform mismatch" },
      {
        kind: "content",
        claim: "Five cards should not use longform",
        layout: { pattern: "longform" },
        body: ["One", "Two", "Three", "Four", "Five"],
      },
    ],
    design: {
      language: "en",
      stylePreset: "custom",
      customBrief: "Editorial deck",
      visualSystem: { styleFamily: "editorial" },
    },
  });

  const { blockingWarnings } =
    testExports.buildVisualDeckBlockingQaWarnings(source);

  assert.match(
    blockingWarnings.join("\n"),
    /visual_shape_layout_mismatch: slide_2 maps cards into longform/,
  );
});

test("custom visual scene rejects unsafe nodes and records warnings", () => {
  const source = testExports.normalizeDeckSource({
    title: "Scene Safety",
    mode: "create",
    slides: [
      {
        kind: "title",
        claim: "Scene Safety",
        visualScene: {
          treatment: "axis-grid",
          nodes: [
            { kind: "text-slot", role: "title", position: "hero" },
            { kind: "script", text: "alert(1)" },
          ],
        },
      },
    ],
    design: {
      stylePreset: "custom",
      visualSystem: {
        styleFamily: "swiss",
        coverTreatment: "axis-grid",
      },
    },
  });

  const metadata = testExports.extractVisualDeckMetadata(source);
  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.equal(metadata.visualSystemVersion, 3);
  assert.equal(metadata.coverTreatment, "axis-grid");
  assert.match(metadata.sceneWarnings.join("\n"), /visual_scene_node_rejected: script/);
  assert.match(html, /data-cover-treatment="axis-grid"/);
  assert.doesNotMatch(html, /alert\(1\)/);
  assert.doesNotMatch(html, /data-node-kind="script"/);
});

test("custom cover treatments vary by visual family", () => {
  const cases = [
    ["swiss", "axis-grid"],
    ["magazine", "masthead"],
    ["blueprint", "schematic-title"],
    ["data-report", "kpi-cover"],
  ] as const;

  for (const [family, treatment] of cases) {
    const source = testExports.normalizeDeckSource({
      title: `${family} cover`,
      mode: "create",
      slides: [{ kind: "title", claim: `${family} cover` }],
      design: {
        stylePreset: "custom",
        visualSystem: {
          styleFamily: family,
          coverTreatment: treatment,
        },
      },
    });
    const html = testExports.buildVisualHtml(source).toString("utf8");

    assert.match(html, new RegExp(`data-sourceweft-family="${family}"`));
    assert.match(html, new RegExp(`data-cover-treatment="${treatment}"`));
    assert.match(html, new RegExp(`cover-${family} cover-${treatment}`));
  }
});

test("custom swiss visual system uses registered swiss layouts and sharp no-shadow tokens", () => {
  const source = testExports.normalizeDeckSource({
    title: "AI Product Field Notes",
    mode: "create",
    slides: [
      { kind: "title", claim: "AI Product Field Notes" },
      {
        kind: "comparison",
        claim: "The old workflow splits context from execution",
        body: {
          columns: [
            { title: "Before", items: ["Manual briefs", "Static docs"] },
            { title: "After", items: ["Live context", "Agentic execution"] },
          ],
        },
      },
      {
        kind: "chart",
        claim: "Usage concentrates around a few repeatable moments",
        body: { data: [{ name: "Draft", value: 42 }, { name: "Review", value: 28 }] },
      },
    ],
    design: {
      language: "en",
      stylePreset: "custom",
      customBrief: "Swiss Style product deck, IKB accent, strict grid, sharp layout.",
      visualSystem: {
        styleFamily: "swiss",
        layoutPolicy: { strict: true, diversity: "high" },
        palette: ["#0A0A0A", "#0033FF", "#FFFFFF"],
      },
    },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");
  const warnings = testExports.buildQaWarnings({
    generationMode: "visual_html",
    source,
    output: {},
  });

  assert.match(html, /data-sourceweft-family="swiss"/);
  assert.match(html, /data-layout="swiss-cover"/);
  assert.match(html, /data-layout="swiss-duo-compare"/);
  assert.match(html, /data-layout="swiss-ledger"/);
  assert.match(html, /--card-radius: 0px/);
  assert.match(html, /--deck-shadow: none/);
  assert.doesNotMatch(warnings.join("\n"), /swiss_visual_rule_violation/);
});

test("native custom decks warn that v3 visual system is normalized", () => {
  const source = testExports.normalizeDeckSource({
    title: "Native Custom",
    mode: "create",
    slides: [
      { kind: "title", claim: "Native Custom" },
      { kind: "content", claim: "Native renderer", body: ["Keeps editable objects."] },
    ],
    design: {
      stylePreset: "custom",
      customBrief: "Swiss product style",
      visualSystem: { styleFamily: "swiss" },
    },
  });

  const warnings = testExports.buildQaWarnings({
    generationMode: "editable_native",
    source,
    output: {},
  });

  const warningText = warnings.join("\n");
  assert.match(warningText, /custom_visual_system_native_limited/);
  assert.match(warningText, /v3/);
  assert.doesNotMatch(warningText, /visual_html|editable_native|html-only/);
});

test("custom visual style without explicit palette is generated from design brief", () => {
  const first = testExports.normalizeDeckSource({
    title: "Generated Theme A",
    mode: "create",
    slides: [
      { kind: "title", claim: "Generated Theme A" },
      { kind: "content", claim: "First", body: ["One"] },
    ],
    design: {
      stylePreset: "custom",
      customBrief: "Minimal porcelain gallery system with quiet whitespace",
    },
  });
  const second = testExports.normalizeDeckSource({
    title: "Generated Theme B",
    mode: "create",
    slides: [
      { kind: "title", claim: "Generated Theme B" },
      { kind: "content", claim: "Second", body: ["Two"] },
    ],
    design: {
      stylePreset: "custom",
      customBrief: "Poster campaign system with bold kinetic typography",
    },
  });

  const firstHtml = testExports.buildVisualHtml(first).toString("utf8");
  const secondHtml = testExports.buildVisualHtml(second).toString("utf8");
  const firstAccent = firstHtml.match(/--accent: (#[0-9A-F]{6})/)?.[1];
  const secondAccent = secondHtml.match(/--accent: (#[0-9A-F]{6})/)?.[1];

  assert.ok(firstAccent);
  assert.ok(secondAccent);
  assert.notEqual(firstAccent, "#334155");
  assert.notEqual(secondAccent, "#334155");
  assert.notEqual(firstAccent, secondAccent);
  assert.match(firstHtml, /data-sourceweft-layout="minimal"/);
  assert.match(secondHtml, /data-sourceweft-layout="poster"/);
});

test("sanitizeFileName preserves generated title text for downloads", () => {
  assert.equal(
    testExports.sanitizeFileName("费曼学习法：用教别人的方式真正学会"),
    "费曼学习法-用教别人的方式真正学会",
  );
  assert.equal(
    testExports.sanitizeFileName('Product / Launch: "Q4"?'),
    "Product-Launch-Q4",
  );
  assert.equal(
    testExports.sanitizeFileName(":::???"),
    "generated-presentation",
  );
});

test("artifact URL helpers build clean preview and source JSON routes", () => {
  assert.equal(
    testExports.buildPptxArtifactUrl({
      workspaceId: "workspace 1",
      artifactId: "artifact 1",
    }),
    "/artifact-preview?artifactId=artifact+1&workspaceId=workspace+1",
  );
  assert.equal(
    testExports.buildSourceJsonArtifactUrl({
      workspaceId: "workspace 1",
      artifactId: "artifact 1",
    }),
    "/v1/workspaces/workspace%201/artifacts/artifact%201/source.json",
  );
});

test("HTML table shim provides style data for PptxGenJS tableToSlides", () => {
  const rows = [
    ["Metric", "Value"],
    ["ARR", "$12M"],
  ];
  const source = testExports.normalizeDeckSource({
    title: "KPI",
    mode: "create",
    slides: [{ kind: "table", claim: "关键指标", body: { rows } }],
    design: { stylePreset: "data-heavy" },
  });
  const shim = testExports.createHtmlTableShim("table_1", rows, {
    accent: "1D4ED8",
    accent2: "16A34A",
    background: "F8FAFC",
    bodyFont: "Aptos",
    card: "FFFFFF",
    chartColors: [],
    grid: "CBD5E1",
    headingFont: "Aptos Display",
    muted: "64748B",
    name: "Data-heavy",
    onAccent: "FFFFFF",
    sectionBackground: "0F172A",
    sectionText: "F8FAFC",
    text: "0F172A",
  });

  assert.equal(source.rendering.preferHtmlTables, true);
  assert.equal(
    shim.document.querySelectorAll("#table_1 tr:first-child th").length,
    2,
  );
  const header = shim.document.querySelector(
    "#table_1 thead tr:first-child th:nth-child(1)",
  );
  assert.equal(header?.innerText, "Metric");
  assert.equal(
    header
      ? shim.window.getComputedStyle(header).getPropertyValue("font-weight")
      : "",
    "700",
  );
});

test("buildPptxBuffer can render styled editable table decks", async () => {
  const source = testExports.normalizeDeckSource({
    title: "KPI",
    mode: "create",
    slides: [
      { kind: "title", claim: "KPI" },
      {
        kind: "table",
        claim: "关键指标",
        body: {
          rows: [
            ["Metric", "Value"],
            ["ARR", "$12M"],
            ["Retention", "92%"],
          ],
        },
      },
    ],
    design: { language: "en", stylePreset: "data-heavy" },
    rendering: { preferHtmlTables: true },
  });

  const buffer = await testExports.buildPptxBuffer(source);

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.byteLength > 1000);
});

test("editable native bullet cards combine visible text and styling", async () => {
  const source = testExports.normalizeDeckSource({
    title: "Clean Objects",
    mode: "create",
    slides: [
      { kind: "title", claim: "Clean Objects" },
      {
        kind: "content",
        claim: "Every visible card is one editable text object",
        body: ["Choose a concept", "Teach it simply", "Find gaps"],
      },
    ],
    design: { language: "en", stylePreset: "executive" },
  });

  const buffer = await testExports.buildPptxBuffer(source);
  const slideXml = testExports
    .extractPptxSlideXml(buffer)
    .find((entry) => entry.path.endsWith("slide2.xml"))?.xml ?? "";
  const shapes = testExports.extractPptxShapeFragments(slideXml);
  const warnings = testExports.inspectEditableNativePptx(buffer);

  assert.match(slideXml, /sw:content:slide-2:step-1/);
  assert.match(slideXml, /Choose a concept/);
  assert.doesNotMatch(slideXml, /sw:content:bullet-marker/);
  assert.equal(
    shapes.filter((shape) => /<a:prstGeom[^>]+prst="roundRect"/.test(shape)).length,
    0,
  );
  assert.doesNotMatch(warnings.join("\n"), /editable_native_empty_shape/);
  assert.doesNotMatch(
    warnings.join("\n"),
    /editable_native_repeated_empty_geometry/,
  );
});

test("editable native comparison uses native content columns", async () => {
  const source = testExports.normalizeDeckSource({
    title: "Comparison",
    mode: "create",
    slides: [
      { kind: "title", claim: "Comparison" },
      {
        kind: "comparison",
        claim: "The new workflow keeps slots intentional",
        body: {
          columns: [
            { title: "Before", items: ["Blank cards", "Separate labels"] },
            { title: "After", items: ["Filled text boxes", "Clean objects"] },
          ],
        },
      },
    ],
    design: { language: "en", stylePreset: "technical" },
  });

  const buffer = await testExports.buildPptxBuffer(source);
  const slideXml = testExports
    .extractPptxSlideXml(buffer)
    .find((entry) => entry.path.endsWith("slide2.xml"))?.xml ?? "";
  const warnings = testExports.inspectEditableNativePptx(buffer);

  assert.match(slideXml, /sw:content:slide-2:column-a/);
  assert.match(slideXml, /Before/);
  assert.match(slideXml, /Blank cards/);
  assert.match(slideXml, /sw:content:slide-2:column-b/);
  assert.doesNotMatch(warnings.join("\n"), /editable_native_empty_shape/);
});

test("buildPptxBuffer keeps native title chrome content-derived", async () => {
  const source = testExports.normalizeDeckSource({
    title: "费曼学习法",
    mode: "create",
    content: {
      cover: {
        title: "用教别人的方式真正学会",
        subtitle: "费曼学习法的四步实践路径",
        kicker: "学习方法工作坊",
      },
    },
    slides: [
      { kind: "title", claim: "费曼学习法" },
      {
        kind: "content",
        claim: "用教别人的方式检验理解",
        title: "输出暴露理解缺口",
        body: ["选择一个概念", "用自己的话解释"],
      },
    ],
    design: {
      aspectRatio: "16:9",
      language: "zh",
      stylePreset: "editorial",
    },
  });

  const buffer = await testExports.buildPptxBuffer(source);
  const parsed = await parseOffice(buffer, {
    ignoreNotes: true,
    newlineDelimiter: "\n",
  });
  const text = parsed.toText();

  assert.match(text, /用教别人的方式真正学会/);
  assert.match(text, /费曼学习法的四步实践路径/);
  assert.match(text, /学习方法工作坊/);
  assert.match(text, /输出暴露理解缺口/);
  assert.doesNotMatch(text, /EDITORIAL/);
  assert.doesNotMatch(text, /Editable PPTX/);
  assert.doesNotMatch(text, /16:9 visual deck/);
});

test("template reference does not supply visible cover copy", () => {
  const source = testExports.normalizeDeckSource({
    title: "AI 生成的封面标题",
    mode: "create",
    content: {
      cover: {
        title: "AI 生成的封面标题",
        subtitle: "AI 生成的封面副标题",
      },
    },
    slides: [{ kind: "title", claim: "模板示例标题不应使用" }],
    templateArtifactId: "template-1",
    template: { usage: "visual_reference" },
  });

  const html = testExports.buildVisualHtml(source).toString("utf8");

  assert.equal(source.template.usage, "visual_reference");
  assert.match(html, /AI 生成的封面标题/);
  assert.match(html, /AI 生成的封面副标题/);
  assert.doesNotMatch(html, /模板示例标题不应使用/);
});

test("buildPptxBuffer supports all configured canvas ratios", async () => {
  for (const aspectRatio of ["16:9", "16:10", "4:3"] as const) {
    const source = testExports.normalizeDeckSource({
      title: `Canvas ${aspectRatio}`,
      mode: "create",
      slides: [
        { kind: "title", claim: `Canvas ${aspectRatio}` },
        {
          kind: "content",
          claim: "核心要点",
          body: ["可编辑文本", "比例正确"],
        },
      ],
      design: { aspectRatio },
    });

    const buffer = await testExports.buildPptxBuffer(source);

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.byteLength > 1000);
  }
});

test("editable native OOXML QA flags empty visible shapes", async () => {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  for (const claim of ["One", "Two", "Three"]) {
    const slide = pptx.addSlide();
    slide.addText(claim, { x: 0.5, y: 0.3, w: 6, h: 0.4 });
    slide.addShape("roundRect", {
      objectName: "orphan-empty-card",
      x: 0.8,
      y: 1.2,
      w: 5.8,
      h: 0.7,
      fill: { color: "FFFFFF" },
      line: { color: "DDDDDD", width: 1 },
    });
  }
  const written = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(written)
    ? written
    : Buffer.from(written as ArrayBuffer);
  const warnings = testExports.inspectEditableNativePptx(buffer);

  assert.match(warnings.join("\n"), /editable_native_empty_shape/);
  assert.match(warnings.join("\n"), /editable_native_repeated_empty_geometry/);
});

test("editable native OOXML QA allows named chrome shapes", async () => {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  slide.addText("Chrome is intentional", { x: 0.5, y: 0.3, w: 6, h: 0.4 });
  slide.addShape("rect", {
    objectName: "sw:chrome:accent-rail",
    x: 0,
    y: 0,
    w: 0.16,
    h: 7.5,
    fill: { color: "0055AA" },
    line: { color: "0055AA" },
  });
  const written = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(written)
    ? written
    : Buffer.from(written as ArrayBuffer);
  const warnings = testExports.inspectEditableNativePptx(buffer);

  assert.doesNotMatch(warnings.join("\n"), /editable_native_empty_shape/);
});
