import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { resolveThreadChatProfile } from "./model-resolution";

const mocks = vi.hoisted(() => ({
  defaultProfile: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@sourceweft/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: mocks.limit,
          }),
        }),
        where: () => ({
          limit: mocks.limit,
        }),
      }),
    }),
  },
  modelGatewayProfiles: {
    isActive: "isActive",
    kind: "kind",
    modelAlias: "modelAlias",
    profileAlias: "profileAlias",
  },
  modelGatewayProviderConfigs: {
    gatewayConfigId: "gatewayConfigId",
    providerKind: "providerKind",
  },
}));

vi.mock("../../../shared/model-gateway/index", () => ({
  requireDefaultModelGatewayProfile: mocks.defaultProfile,
}));

test("resolveThreadChatProfile falls back to active default for stale requested profile aliases", async () => {
  mocks.limit.mockResolvedValueOnce([]);
  mocks.defaultProfile.mockResolvedValueOnce({
    profileAlias: "chat-default-active",
    modelAlias: "openrouter/default-chat",
  });

  const profile = await resolveThreadChatProfile({
    requestedProfileAlias: "stale-chat-profile",
    threadModelSettings: {
      llmProfileAlias: "pinned-chat-profile",
      imageProfileAlias: null,
      visionProfileAlias: null,
      llmModelAlias: "openrouter/pinned-chat",
      imageModelAlias: null,
      visionModelAlias: null,
    },
  });

  assert.deepEqual(profile, {
    profileAlias: "chat-default-active",
    modelAlias: "openrouter/default-chat",
    persistedProfileAlias: "chat-default-active",
    persistedModelAlias: "openrouter/default-chat",
  });
});
