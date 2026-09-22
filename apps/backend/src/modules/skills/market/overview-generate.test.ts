import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  claim: vi.fn(),
  cache: vi.fn(),
  publish: vi.fn(),
  request: vi.fn(),
}));
vi.mock("./overview-repository", () => ({
  findSkillOverviewSubject: mocks.find,
  readSkillOverviewBilling: vi.fn(),
}));
vi.mock("./analysis-repository", () => ({
  claimSkillAnalysis: mocks.claim,
  findCachedSkillAnalysis: mocks.cache,
  publishSkillAnalysis: mocks.publish,
  requestSkillAnalysis: mocks.request,
}));
vi.mock("./read-repository", () => ({ marketSkillName: () => "Charts" }));
vi.mock("../../../shared/model-gateway/index", () => ({
  resolveModelGatewayProfile: vi.fn(),
  withBilledModelGateway: vi.fn(),
}));
import { generateSkillOverview } from "./overview-generate";
const localized = (summary: string) => ({
  summary,
  whatItDoes: summary,
  whenToUse: "When charts are needed",
  requirements: "",
});
const output = {
  en: localized("Makes charts."),
  "zh-CN": localized("生成图表。"),
  "zh-TW": localized("製作圖表，整理資料。"),
  classification: {
    status: "ready",
    primary: "data-analytics",
    secondary: null,
    rationale: "Charts are data visualization",
    evidence: ["Makes charts."],
  },
};
const input = () => ({
  skillVersionId: "v",
  requestId: "r",
  scopeId: "scope",
  modelConfigurationKey: "model-config",
  readBilling: async () => ({ teamId: "t", workspaceId: "w", userId: "u" }),
  callModel: vi.fn(async () => ({ output, model: "test" })),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue({
    skillId: "s",
    skillVersionId: "v",
    eligible: true,
    slug: "charts",
    bundleSha256: "sha",
    skillMd: "Makes charts.",
    manifest: {},
  });
  mocks.claim.mockResolvedValue({ requestId: "r", force: false });
  mocks.cache.mockResolvedValue(null);
  mocks.publish.mockResolvedValue(true);
});
test("publishes independently generated Traditional Chinese and shared categories", async () => {
  const request = input();
  expect(await generateSkillOverview(request)).toEqual({
    status: "generated",
    model: "test",
  });
  expect(request.callModel).toHaveBeenCalledTimes(1);
  expect(mocks.publish.mock.calls[0]![0]).toMatchObject({
    classification: output.classification,
    overviews: {
      "zh-TW": {
        summary: "製作圖表，整理資料。",
        suggestedCategories: ["data-analytics"],
      },
    },
  });
});
test("forced regeneration bypasses cache and retains output until success", async () => {
  const request = { ...input(), force: true };
  mocks.claim.mockResolvedValue({ requestId: "r", force: true });
  await generateSkillOverview(request);
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(request.callModel).toHaveBeenCalledTimes(1);
});
test("a complete cached analysis still passes through atomic category publication", async () => {
  mocks.cache.mockResolvedValue({
    model: "cached",
    classification: output.classification,
    overviews: {
      en: localized("cached"),
      "zh-CN": localized("cached"),
      "zh-TW": localized("cached"),
    },
  });
  const request = input();
  expect(await generateSkillOverview(request)).toEqual({
    status: "copied",
    rows: 3,
  });
  expect(request.callModel).not.toHaveBeenCalled();
  expect(mocks.publish).toHaveBeenCalledTimes(1);
});
test("malformed model output never publishes or deletes old rows", async () => {
  const request = input();
  request.callModel.mockResolvedValue({
    model: "test",
    output: { ...output, "zh-TW": undefined } as unknown as typeof output,
  });
  await expect(generateSkillOverview(request)).rejects.toThrow();
  expect(mocks.publish).not.toHaveBeenCalled();
});
test("stale request does not call a model; stale publication is reported as skipped", async () => {
  mocks.claim.mockResolvedValue(null);
  const request = input();
  expect(await generateSkillOverview(request)).toMatchObject({
    status: "skipped",
  });
  expect(request.callModel).not.toHaveBeenCalled();
  mocks.claim.mockResolvedValue({ requestId: "r", force: false });
  mocks.publish.mockResolvedValue(false);
  expect(await generateSkillOverview(request)).toMatchObject({
    status: "skipped",
    reason: "not-eligible",
  });
});
