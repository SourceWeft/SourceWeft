import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("../../../shared/model-gateway/system-client", () => ({
  resolveSystemModelIdentity: mocks.identity,
}));
import { resolveSkillAnalysisModelKey } from "./analysis-model";
import { skillAnalysisModelConfigurationKey } from "./analysis-evaluation";

const identity = {
  provider: "openrouter",
  kind: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiVersion: null,
  model: "deepseek/deepseek-v4.1-flash",
};

beforeEach(() => {
  mocks.identity.mockReset();
});

test("analyses are keyed by the configured system model", async () => {
  mocks.identity.mockResolvedValue(identity);
  const key = await resolveSkillAnalysisModelKey();
  expect(key).toBe(skillAnalysisModelConfigurationKey(identity));

  mocks.identity.mockResolvedValue({ ...identity, model: "other/model" });
  expect(await resolveSkillAnalysisModelKey()).not.toBe(key);
  mocks.identity.mockResolvedValue({
    ...identity,
    baseUrl: "https://gateway.example/v1",
  });
  expect(await resolveSkillAnalysisModelKey()).not.toBe(key);
});

test("no key while the system model is not configured", async () => {
  mocks.identity.mockResolvedValue(null);
  expect(await resolveSkillAnalysisModelKey()).toBeNull();
});
