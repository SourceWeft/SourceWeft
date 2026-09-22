import { expect, test, vi } from "vitest";
vi.mock("../../../shared/model-gateway/runtime", () => ({
  loadRoutedGatewayConfig: vi.fn(),
}));
import { analysisRoutingIdentity } from "./analysis-model";
import { skillAnalysisModelConfigurationKey } from "./analysis-evaluation";
import type { RoutedGatewayConfig } from "../../../shared/model-gateway/types";
const profile = {
  id: "p",
  gatewayConfigId: "g",
  profileAlias: "chat",
  modelAlias: "m",
  updatedAt: "yesterday",
};
const config = () =>
  ({
    versionId: "v",
    providers: {
      provider: {
        kind: "openai-compatible",
        baseUrl:
          "https://user:password@example.com/api?api_key=secret&api-version=1",
        apiKey: "credential",
        globalReady: true,
      },
    },
    modelRoutes: {
      chat: {
        strategy: "priority",
        targets: [{ provider: "provider", model: "model-a", priority: 1 }],
      },
    },
  }) as unknown as RoutedGatewayConfig;
test("fingerprint tracks model and endpoint changes without credentials or pricing timestamps", () => {
  const a = config();
  const safe = analysisRoutingIdentity(profile, a);
  const text = JSON.stringify(safe);
  expect(text).not.toMatch(/password|secret|credential|user:/);
  const key = skillAnalysisModelConfigurationKey(profile, safe);
  const b = config();
  b.providers.provider!.apiKey = "rotated";
  b.providers.provider!.baseUrl =
    "https://different:rotated@example.com/api?api_key=changed&api-version=1";
  expect(
    skillAnalysisModelConfigurationKey(
      { ...profile, updatedAt: "today" },
      analysisRoutingIdentity(profile, b),
    ),
  ).toBe(key);
  b.modelRoutes.chat!.targets[0]!.model = "model-b";
  expect(
    skillAnalysisModelConfigurationKey(
      profile,
      analysisRoutingIdentity(profile, b),
    ),
  ).not.toBe(key);
});
