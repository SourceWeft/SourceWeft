import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createHtmlVisualReviewTools } from "../src/html/visual-review";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function factory(content: string, profile = true) {
  const complete = vi.fn().mockResolvedValue({ raw: { content } }),
    download = vi.fn().mockResolvedValue(png);
  const tools = createHtmlVisualReviewTools({
    toolIds: ["review_html_visuals"],
    context: {
      userMessageId: "message",
      shouldBindAgentTool: () => true,
      turnState: {
        review_html_visuals: {
          visionProfile: profile
            ? { gatewayConfigId: "g", profileAlias: "vision", modelAlias: "v" }
            : null,
        },
      },
    },
    services: {
      sandbox: {
        allowedReadRoots: ["/workspace"],
        downloadCurrentFile: download,
      },
      modelGateway: {
        getClient: async () => ({ chat: { complete } }),
      } as never,
    },
  });
  return { tool: tools[0]!.tool, complete, download };
}
test("missing vision profile is a failure without reading images or selecting another model", async () => {
  const f = factory("", false);
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: ["/workspace/a.png"],
      criteria: "Check readability",
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.reason, "VISION_PROFILE_UNAVAILABLE");
  assert.equal(f.complete.mock.calls.length, 0);
  assert.equal(f.download.mock.calls.length, 0);
});
test("review rejects a path escaping the authorized sandbox root", async () => {
  const f = factory("");
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/../private/a.png"],
      criteria: "Check readability",
    }),
    /NOT_AUTHORIZED/,
  );
  assert.equal(f.complete.mock.calls.length, 0);
});
test("every image must have a unique complete verdict", async () => {
  const f = factory(
    JSON.stringify({
      verdicts: [{ imageIndex: 1, severity: "none", issues: [] }],
    }),
  );
  await assert.rejects(
    f.tool.invoke({
      imagePaths: ["/workspace/a.png", "/workspace/b.png"],
      criteria: "Check layout",
    }),
    /INCOMPLETE/,
  );
  assert.equal(f.complete.mock.calls.length, 1);
});
test("major findings fail a complete review", async () => {
  const f = factory(
    JSON.stringify({
      verdicts: [
        { imageIndex: 1, severity: "major", issues: ["Clipped title"] },
      ],
    }),
  );
  const r = JSON.parse(
    await f.tool.invoke({
      imagePaths: ["/workspace/a.png"],
      criteria: "Check layout",
    }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.reviewedImages, 1);
});
