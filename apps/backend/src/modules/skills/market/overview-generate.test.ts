import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  claim: vi.fn(),
  cache: vi.fn(),
  publish: vi.fn(),
  request: vi.fn(),
  readiness: vi.fn(),
  withSystemModel: vi.fn(),
}));
vi.mock("./overview-repository", () => ({
  findSkillOverviewSubject: mocks.find,
}));
vi.mock("./analysis-repository", () => ({
  claimSkillAnalysis: mocks.claim,
  findCachedSkillAnalysis: mocks.cache,
  publishSkillAnalysis: mocks.publish,
  requestSkillAnalysis: mocks.request,
}));
vi.mock("./read-repository", () => ({ marketSkillName: () => "Charts" }));
vi.mock("../../../shared/model-gateway/system-client", () => ({
  getSystemModelReadiness: mocks.readiness,
  withSystemModel: mocks.withSystemModel,
}));
import {
  SKILL_OVERVIEW_MAX_OUTPUT_TOKENS,
  createSkillOverviewModelCall,
  generateSkillOverview,
} from "./overview-generate";
import {
  SKILL_OVERVIEW_OUTPUT_JSON_SCHEMA,
  SKILL_OVERVIEW_OUTPUT_NAME,
  type SkillOverviewPrompt,
} from "./overview-prompt";
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
  modelReady: async () => true,
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
test("a system model that is not ready stops the job before any model call", async () => {
  const request = { ...input(), modelReady: undefined };
  mocks.readiness.mockResolvedValue({ ready: false });
  expect(await generateSkillOverview(request)).toEqual({
    status: "skipped",
    reason: "system-model-not-ready",
  });
  expect(request.callModel).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});
test("the model call goes through the system model with the overview request", async () => {
  const complete = vi.fn(async () => ({
    structuredOutput: output,
    providerModel: "deepseek/deepseek-v4.1-flash",
    model: "system:market",
    raw: { content: "" },
  }));
  mocks.withSystemModel.mockImplementation(
    async (_context: unknown, run: (chat: unknown) => Promise<unknown>) =>
      run({ complete }),
  );
  const prompt: SkillOverviewPrompt = {
    system: "system prompt",
    user: "user prompt",
    sourceText: "source",
    truncated: false,
    inputFingerprint: "fingerprint",
  };
  const result = await createSkillOverviewModelCall()({
    prompt,
    skillVersionId: "v",
    scopeId: "scope",
  });
  expect(result).toEqual({
    output,
    model: "deepseek/deepseek-v4.1-flash",
  });
  expect(mocks.withSystemModel.mock.calls[0]![0]).toEqual({
    purpose: "skill_market.overview",
    subjectRef: "skill-version:v",
    scopeId: "scope",
  });
  expect(complete).toHaveBeenCalledWith({
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ],
    structuredOutput: {
      name: SKILL_OVERVIEW_OUTPUT_NAME,
      description:
        "A catalog overview of the skill in English, Simplified Chinese and Taiwan Traditional Chinese, plus one classification.",
      schema: SKILL_OVERVIEW_OUTPUT_JSON_SCHEMA,
    },
    thinking: { mode: "off", enabled: false, includeReasoning: false },
    maxTokens: SKILL_OVERVIEW_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
  });

  await createSkillOverviewModelCall("skill_market.evaluation")({
    prompt,
    skillVersionId: "v2",
    scopeId: "eval-scope",
  });
  expect(mocks.withSystemModel.mock.calls[1]![0]).toEqual({
    purpose: "skill_market.evaluation",
    subjectRef: "skill-version:v2",
    scopeId: "eval-scope",
  });
});
