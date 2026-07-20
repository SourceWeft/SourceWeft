import assert from "node:assert/strict";
import { test } from "vitest";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import {
  formatThinkingMetadataValue,
  getConnectorResultSummary,
  getConnectorToolResult,
  getGeneratedImagePrompt,
  getGeneratedImageStatus,
  getGeneratedImageTitle,
  getThinkingMetadataParts,
  getToolFetchUrls,
  getToolQuery,
  getToolStepMetadataParts,
  getArtifactGenerationProgressLabel,
  getArtifactStageLabel,
  getVisionFallbackImages,
  normalizeConnectorPages,
  pluralize,
  summarizeToolOutput,
} from "./reasoning-trace-tools";
import { GENERATE_VIDEO_PRESENTATION_TOOL_NAME } from "@sourceweft/builtin-tool-video-presentation/agent-tool-defs";
import type { ToolCallRecord } from "./types";

const VIDEO_TOOL = GENERATE_VIDEO_PRESENTATION_TOOL_NAME;

// Connector tools are registered at runtime rather than baked into the static
// registry, so register a representative one before exercising connector paths.
registerAgentTools([
  {
    id: "searchNotionPages",
    name: "search_notion_pages",
    domain: "connector",
    capabilities: ["connector", "connector_read", "notion"],
    activation: {
      default: "off",
      userControl: "none",
      skill: { declarable: true, activates: true },
    },
  },
]);

function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "tool-1",
    tool: "generate_image",
    input: {},
    output: null,
    latencyMs: null,
    status: "completed",
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getToolQuery / getToolFetchUrls
// ---------------------------------------------------------------------------

test("getToolQuery prefers input query over output and metadata", () => {
  assert.equal(
    getToolQuery(
      toolCall({
        input: { query: "  from input  " },
        output: { query: "from output" },
      }),
      { id: "s", metadata: { query: "from metadata" } } as never,
    ),
    "from input",
  );
});

test("getToolQuery falls back to output then step metadata", () => {
  assert.equal(
    getToolQuery(toolCall({ input: {}, output: { query: " from output " } })),
    "from output",
  );
  assert.equal(
    getToolQuery(toolCall({ input: { query: "   " }, output: null }), {
      id: "s",
      metadata: { query: " from metadata " },
    } as never),
    "from metadata",
  );
});

test("getToolQuery returns null when no source has a non-blank query", () => {
  assert.equal(getToolQuery(toolCall({ input: { query: "  " } })), null);
  // A non-object output must not throw when probed for `query`.
  assert.equal(getToolQuery(toolCall({ output: "plain string" })), null);
});

test("getToolFetchUrls keeps only trimmed string urls from input items", () => {
  assert.deepEqual(
    getToolFetchUrls(
      toolCall({
        input: {
          items: [
            { url: " https://a.example " },
            { url: "" },
            { url: 42 },
            null,
            ["https://nested.example"],
            { url: "https://b.example" },
          ],
        },
      }),
    ),
    ["https://a.example", "https://b.example"],
  );
});

test("getToolFetchUrls returns empty array when items is not an array", () => {
  assert.deepEqual(getToolFetchUrls(toolCall({ input: { items: {} } })), []);
  assert.deepEqual(getToolFetchUrls(toolCall({ input: {} })), []);
});

// ---------------------------------------------------------------------------
// summarizeToolOutput
// ---------------------------------------------------------------------------

test("summarizeToolOutput compacts whitespace in plain tool content", () => {
  assert.equal(
    summarizeToolOutput(
      { content: "line one\n\n  line   two  " },
      "some_tool",
    ),
    "line one line two",
  );
});

test("summarizeToolOutput suppresses confirmation-request outputs", () => {
  const confirmation = {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "action-1",
    domain: "connector",
    subject: { label: "Notion", provider: "notion" },
    action: {
      type: "notion.page.trash",
      toolName: "delete_notion_page",
      label: "Delete",
      riskLevel: "high",
      status: "pending",
      requiresApproval: true,
    },
    decisionOptions: [{ decision: "approve", label: "Approve" }],
    status: "pending",
  };
  assert.equal(summarizeToolOutput(confirmation, "delete_notion_page"), null);
});

test("summarizeToolOutput returns null when there is no content", () => {
  assert.equal(summarizeToolOutput(null, "some_tool"), null);
  assert.equal(summarizeToolOutput({}, "some_tool"), null);
});

// ---------------------------------------------------------------------------
// getGeneratedImageStatus
// ---------------------------------------------------------------------------

test("getGeneratedImageStatus derives aspect ratio from output dimensions", () => {
  const status = getGeneratedImageStatus(
    toolCall({ output: { width: 1024, height: 768 } }),
  );
  assert.equal(status.aspectRatio, "1024 / 768");
});

test("getGeneratedImageStatus parses ratio strings and prefers output over input", () => {
  assert.equal(
    getGeneratedImageStatus(
      toolCall({ input: { aspectRatio: "1:1" }, output: { aspectRatio: "16:9" } }),
    ).aspectRatio,
    "16 / 9",
  );
  assert.equal(
    getGeneratedImageStatus(toolCall({ input: { aspectRatio: "3:2" } }))
      .aspectRatio,
    "3 / 2",
  );
});

test("getGeneratedImageStatus falls back to the default aspect ratio", () => {
  // "auto", malformed ratios, and a zero denominator are all unusable.
  for (const aspectRatio of ["auto", "wide", "16:0", "16/9"]) {
    assert.equal(
      getGeneratedImageStatus(toolCall({ input: { aspectRatio } })).aspectRatio,
      "4 / 3",
      `expected default for ${aspectRatio}`,
    );
  }
});

test("getGeneratedImageStatus maps known stages to progress", () => {
  const generating = getGeneratedImageStatus(
    toolCall({ output: { stage: " generating " } }),
  );
  assert.equal(generating.stage, "generating");
  assert.equal(generating.progress, 1);

  const ready = getGeneratedImageStatus(toolCall({ output: { stage: "ready" } }));
  assert.equal(ready.progress, 4);
});

test("getGeneratedImageStatus has no progress for unknown stages", () => {
  const status = getGeneratedImageStatus(
    toolCall({ output: { stage: "post_processing" } }),
  );
  assert.equal(status.progress, null);
});

test("getGeneratedImageStatus returns null stage when absent", () => {
  const status = getGeneratedImageStatus(toolCall({ output: {} }));
  assert.equal(status.stage, null);
  assert.equal(status.progress, null);
});

// ---------------------------------------------------------------------------
// image title / prompt
// ---------------------------------------------------------------------------

test("getGeneratedImageTitle prefers output title, then input title, then prompt", () => {
  assert.equal(
    getGeneratedImageTitle(
      toolCall({ input: { title: "in" }, output: { title: " out " } }),
    ),
    "out",
  );
  assert.equal(
    getGeneratedImageTitle(toolCall({ input: { title: " in " } })),
    "in",
  );
  assert.equal(
    getGeneratedImageTitle(toolCall({ input: { prompt: "a  red   balloon" } })),
    "a red balloon",
  );
  assert.equal(getGeneratedImageTitle(toolCall()), null);
});

test("getGeneratedImagePrompt prefers input prompt over output prompt", () => {
  assert.equal(
    getGeneratedImagePrompt(
      toolCall({ input: { prompt: " in " }, output: { prompt: "out" } }),
    ),
    "in",
  );
  assert.equal(
    getGeneratedImagePrompt(toolCall({ output: { prompt: " out " } })),
    "out",
  );
});

// ---------------------------------------------------------------------------
// artifact stage / progress labels (video presentation capability)
// ---------------------------------------------------------------------------

test("getArtifactStageLabel maps each known video stage", () => {
  const cases: Array<[string, string]> = [
    ["planning", "Planning video scenes"],
    ["generating_project_code", "Generating Remotion project code"],
    ["installing_project", "Installing project dependencies"],
    ["typechecking_project", "Typechecking project"],
    ["rendering_smoke_preview", "Rendering smoke preview"],
    ["materializing_assets", "Preparing visual assets"],
    ["generating_audio_tracks", "Generating narration audio"],
    ["assigning_slide_themes", "Assigning slide themes"],
    ["generating_scene_modules", "Generating Remotion scene code"],
    ["repairing_scene_modules", "Repairing scene code"],
    ["verifying_visual_quality", "Reviewing rendered slides"],
    ["publishing_video_project", "Publishing video project"],
    ["ready", "Ready for browser video export"],
    ["failed", "Video project failed"],
  ];
  for (const [stage, label] of cases) {
    assert.equal(
      getArtifactStageLabel(VIDEO_TOOL, { generation: { stage } }),
      label,
      `stage ${stage}`,
    );
  }
});

test("getArtifactStageLabel collapses the two storyboard stages", () => {
  assert.equal(
    getArtifactStageLabel(VIDEO_TOOL, { generation: { stage: "planning_storyboard" } }),
    "Planning storyboard",
  );
  assert.equal(
    getArtifactStageLabel(VIDEO_TOOL, {
      generation: { stage: "normalizing_blueprint" },
    }),
    "Planning storyboard",
  );
});

test("getArtifactStageLabel returns null for unusable payloads", () => {
  assert.equal(getArtifactStageLabel(VIDEO_TOOL, undefined), null);
  assert.equal(getArtifactStageLabel(VIDEO_TOOL, {}), null);
  assert.equal(getArtifactStageLabel(VIDEO_TOOL, { generation: null }), null);
  // An array must not be treated as a generation record.
  assert.equal(getArtifactStageLabel(VIDEO_TOOL, { generation: [] }), null);
  assert.equal(getArtifactStageLabel(VIDEO_TOOL, { generation: { stage: 7 } }), null);
  assert.equal(
    getArtifactStageLabel(VIDEO_TOOL, { generation: { stage: "unknown_stage" } }),
    null,
  );
});

test("getArtifactGenerationProgressLabel clamps and rounds progress", () => {
  assert.equal(
    getArtifactGenerationProgressLabel(VIDEO_TOOL, {
      generation: { stage: "planning", progress: 42.6 },
    }),
    "Planning video scenes 43%",
  );
  assert.equal(
    getArtifactGenerationProgressLabel(VIDEO_TOOL, {
      generation: { stage: "planning", progress: 140 },
    }),
    "Planning video scenes 100%",
  );
  assert.equal(
    getArtifactGenerationProgressLabel(VIDEO_TOOL, {
      generation: { stage: "planning", progress: -5 },
    }),
    "Planning video scenes 0%",
  );
});

test("getArtifactGenerationProgressLabel appends attempt and error suffixes", () => {
  assert.equal(
    getArtifactGenerationProgressLabel(VIDEO_TOOL, {
      generation: {
        retrying: true,
        progress: 10,
        attempt: 2,
        maxAttempts: 3,
        errorMessage: "  boom  ",
      },
    }),
    "Retrying video generation 10% · attempt 2/3 · boom",
  );
});

test("getArtifactGenerationProgressLabel reports failure and default states", () => {
  assert.equal(
    getArtifactGenerationProgressLabel(VIDEO_TOOL, { generation: { status: "failed" } }),
    "Video project failed",
  );
  assert.equal(
    getArtifactGenerationProgressLabel(VIDEO_TOOL, undefined),
    "Preparing video project",
  );
});

// ---------------------------------------------------------------------------
// connector results
// ---------------------------------------------------------------------------

test("getConnectorToolResult ignores non-connector tools and other outputs", () => {
  assert.equal(
    getConnectorToolResult(
      toolCall({ tool: "generate_image", output: { type: "connector_tool_result" } }),
    ),
    null,
  );
  assert.equal(
    getConnectorToolResult(
      toolCall({ tool: "search_notion_pages", output: { type: "something_else" } }),
    ),
    null,
  );
  assert.equal(
    getConnectorToolResult(toolCall({ tool: "search_notion_pages", output: [] })),
    null,
  );
});

test("getConnectorToolResult normalizes connector output fields", () => {
  const result = getConnectorToolResult(
    toolCall({
      tool: "search_notion_pages",
      output: {
        type: "connector_tool_result",
        connector: " notion ",
        actionType: " notion.page.find ",
        query: "  servers  ",
        resultCount: 2,
        pageId: " page-1 ",
        title: " Root ",
        url: " https://notion.example/page ",
        toolName: " search_notion_pages ",
      },
    }),
  );
  assert.ok(result);
  assert.equal(result.provider, "Notion");
  assert.equal(result.actionType, "notion.page.find");
  assert.equal(result.query, "servers");
  assert.equal(result.resultCount, 2);
  assert.equal(result.pageId, "page-1");
  assert.equal(result.title, "Root");
  assert.equal(result.url, "https://notion.example/page");
  assert.equal(result.toolName, "search_notion_pages");
});

test("getConnectorToolResult falls back to defaults for missing fields", () => {
  const result = getConnectorToolResult(
    toolCall({
      tool: "search_notion_pages",
      output: { type: "connector_tool_result", resultCount: Number.NaN },
    }),
  );
  assert.ok(result);
  assert.equal(result.provider, "Connector");
  // toolName falls back to the tool call's own name.
  assert.equal(result.toolName, "search_notion_pages");
  // NaN is not a finite result count.
  assert.equal(result.resultCount, null);
  assert.deepEqual(result.pages, []);
});

test("getConnectorResultSummary prefers result count over page id", () => {
  assert.equal(
    getConnectorResultSummary({
      actionType: null,
      pageId: "page-1",
      pages: [],
      provider: "Notion",
      query: "servers",
      resultCount: 2,
      title: null,
      toolName: "search_notion_pages",
      url: null,
    }),
    'Found 2 pages for "servers".',
  );
});

test("getConnectorResultSummary singularizes a single result", () => {
  assert.equal(
    getConnectorResultSummary({
      actionType: null,
      pageId: null,
      pages: [],
      provider: "Notion",
      query: null,
      resultCount: 1,
      title: null,
      toolName: "search_notion_pages",
      url: null,
    }),
    "Found 1 page.",
  );
});

test("getConnectorResultSummary falls back to page id, then null", () => {
  const base = {
    actionType: null,
    pages: [],
    provider: "Notion",
    query: null,
    resultCount: null,
    title: null,
    toolName: "search_notion_pages",
    url: null,
  };
  assert.equal(
    getConnectorResultSummary({ ...base, pageId: "page-1" }),
    "Page ID: page-1",
  );
  assert.equal(getConnectorResultSummary({ ...base, pageId: null }), null);
});

// ---------------------------------------------------------------------------
// normalizeConnectorPages
// ---------------------------------------------------------------------------

test("normalizeConnectorPages returns empty for non-arrays", () => {
  assert.deepEqual(normalizeConnectorPages(undefined), []);
  assert.deepEqual(normalizeConnectorPages(null), []);
  assert.deepEqual(normalizeConnectorPages({ pages: [] }), []);
  assert.deepEqual(normalizeConnectorPages("pages"), []);
});

test("normalizeConnectorPages trims fields and nulls out blanks", () => {
  assert.deepEqual(
    normalizeConnectorPages([
      {
        pageId: " page-1 ",
        title: " Root ",
        url: " https://notion.example/1 ",
        lastEditedTime: " 2026-01-01T00:00:00Z ",
      },
    ]),
    [
      {
        lastEditedTime: "2026-01-01T00:00:00Z",
        pageId: "page-1",
        title: "Root",
        url: "https://notion.example/1",
      },
    ],
  );
});

test("normalizeConnectorPages drops entries with no string identity fields", () => {
  assert.deepEqual(
    normalizeConnectorPages([
      null,
      "page",
      ["page"],
      { lastEditedTime: "2026-01-01T00:00:00Z" },
      { pageId: 7, title: null, url: undefined },
    ]),
    [],
  );
});

test("normalizeConnectorPages keeps entries with a blank but present string field", () => {
  // A blank string still satisfies the typeof check, so the entry survives
  // with every field normalized to null.
  assert.deepEqual(normalizeConnectorPages([{ title: "   " }]), [
    { lastEditedTime: null, pageId: null, title: null, url: null },
  ]);
});

// ---------------------------------------------------------------------------
// thinking metadata
// ---------------------------------------------------------------------------

test("formatThinkingMetadataValue drops false booleans and empty values", () => {
  assert.equal(formatThinkingMetadataValue("truncated", false), null);
  assert.equal(formatThinkingMetadataValue("truncated", true), "yes");
  assert.equal(formatThinkingMetadataValue("hitCount", null), null);
  assert.equal(formatThinkingMetadataValue("hitCount", undefined), null);
  assert.equal(formatThinkingMetadataValue("hitCount", "   "), null);
});

test("formatThinkingMetadataValue formats latency and zero removed citations", () => {
  assert.equal(formatThinkingMetadataValue("latencyMs", 12.4), "12ms");
  assert.equal(formatThinkingMetadataValue("removedCitationCount", 0), null);
  assert.equal(formatThinkingMetadataValue("removedCitationCount", 3), "3");
  assert.equal(formatThinkingMetadataValue("hitCount", 5), "5");
});

test("getThinkingMetadataParts renders only known, meaningful keys", () => {
  assert.deepEqual(
    getThinkingMetadataParts({
      hitCount: 3,
      latencyMs: 120,
      truncated: false,
      removedCitationCount: 0,
      unknownKey: "ignored",
    }),
    ["hits: 3", "time: 120ms"],
  );
  assert.deepEqual(getThinkingMetadataParts(undefined), []);
});

test("getToolStepMetadataParts strips keys already shown elsewhere", () => {
  assert.deepEqual(
    getToolStepMetadataParts({
      hitCount: 3,
      latencyMs: 120,
      limit: 10,
      pageCount: 4,
      query: "servers",
      resultCount: 2,
      urlCount: 1,
      concurrency: 2,
      sourceCount: 6,
    }),
    ["sources: 6"],
  );
  assert.deepEqual(getToolStepMetadataParts(undefined), []);
});

// ---------------------------------------------------------------------------
// vision fallback images
// ---------------------------------------------------------------------------

test("getVisionFallbackImages drops entries without a usable url", () => {
  assert.deepEqual(
    getVisionFallbackImages({
      images: [null, "img", { fileName: "a.png" }, { url: "   " }],
    }),
    [],
  );
  assert.deepEqual(getVisionFallbackImages({ images: {} }), []);
  assert.deepEqual(getVisionFallbackImages(undefined), []);
});

test("getVisionFallbackImages defaults file name and image id", () => {
  const [image] = getVisionFallbackImages({
    images: [{ url: "https://cdn.example/a.png" }],
  });
  assert.ok(image);
  assert.equal(image.fileName, "image");
  // imageId falls back to the (defaulted) file name.
  assert.equal(image.imageId, "image");
  assert.equal(image.description, "");
  assert.equal(image.mimeType, null);
});

test("getVisionFallbackImages trims provided fields", () => {
  const [image] = getVisionFallbackImages({
    images: [
      {
        url: "https://cdn.example/a.png",
        fileName: " chart.png ",
        imageId: " img-1 ",
        description: "  a chart  ",
        mimeType: " image/png ",
      },
    ],
  });
  assert.ok(image);
  assert.equal(image.fileName, "chart.png");
  assert.equal(image.imageId, "img-1");
  assert.equal(image.description, "a chart");
  assert.equal(image.mimeType, "image/png");
});

// ---------------------------------------------------------------------------
// pluralize
// ---------------------------------------------------------------------------

test("pluralize switches on exactly one", () => {
  assert.equal(pluralize(1, "page"), "page");
  assert.equal(pluralize(0, "page"), "pages");
  assert.equal(pluralize(2, "page"), "pages");
  assert.equal(pluralize(2, "entry", "entries"), "entries");
});
