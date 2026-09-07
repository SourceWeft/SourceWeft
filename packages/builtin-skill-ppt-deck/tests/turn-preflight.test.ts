import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentToolTurnPreflightInput,
  AgentToolModelProfileRequest,
} from "@sourceweft/contracts/agent-tools";
import { reviewDeckVisualsTurnPreflight } from "../src/turn-preflight";

function harness(overrides: Partial<AgentToolTurnPreflightInput> = {}) {
  const requests: AgentToolModelProfileRequest[] = [];
  const run = () =>
    reviewDeckVisualsTurnPreflight.run({
      toolName: "review_deck_visuals",
      modelKind: "vision",
      selection: null,
      command: null,
      enabledSkills: [],
      defaultEnabled: true,
      execution: undefined,
      threadProfileAlias: "thread-vision",
      services: {
        async resolveProfile(request) {
          requests.push(request);
          if (request.profileAlias === "missing")
            throw new Error("missing profile");
          return {
            gatewayConfigId: "global-gateway",
            profileAlias: request.profileAlias ?? "default-vision",
            modelAlias:
              request.modelAlias ?? request.profileAlias ?? "default-vision",
          };
        },
        synthesizeByokProfile(request) {
          return { ...request, gatewayConfigId: "" };
        },
      },
      ...overrides,
    });
  return { run, requests };
}

test("PPT review uses request, execution, thread, skill and explicit-default vision choices", async () => {
  for (const [overrides, expected] of [
    [
      { requestedProfileAlias: "request-vision" },
      { profileAlias: "request-vision", required: true },
    ],
    [
      { execution: { profileAlias: "execution-vision" } },
      { profileAlias: "execution-vision", required: true },
    ],
    [
      { execution: { modelAlias: "explicit-model" } },
      { modelAlias: "explicit-model", required: true },
    ],
    [{}, { profileAlias: "thread-vision", required: true }],
    [
      {
        threadProfileAlias: null,
        enabledSkills: [
          {
            tools: ["review_deck_visuals"],
            models: { vision: "skill-vision" },
          },
        ],
      },
      { profileAlias: "skill-vision", required: true },
    ],
    [
      {
        requestedProfileAlias: null,
        execution: { profileAlias: "old-choice" },
      },
      { required: false },
    ],
  ] as const) {
    const h = harness(overrides as Partial<AgentToolTurnPreflightInput>);
    await h.run();
    assert.deepEqual(h.requests, [expected]);
  }
});

test("PPT review does not switch a missing explicit vision choice to default", async () => {
  const h = harness({ requestedProfileAlias: "missing" });
  await assert.rejects(h.run(), /missing profile/);
  assert.equal(h.requests.length, 1);
});

test("PPT BYOK never resolves or borrows a global profile or credential", async () => {
  const execution = {
    executionMode: "BYOK" as const,
    providerModel: "my-vision",
    providerHint: "custom",
    byokModelId: "model-1",
    credentialId: "credential-1",
    byok: {
      provider: "custom",
      providerKind: "openai-compatible",
      apiKey: "owned-key",
    },
  };
  const h = harness({ execution });
  const result = await h.run();
  const state = result?.state as {
    visionProfile: { gatewayConfigId: string; modelAlias: string };
    execution: unknown;
  };
  assert.deepEqual(h.requests, []);
  assert.equal(state.visionProfile.gatewayConfigId, "");
  assert.equal(state.visionProfile.modelAlias, "my-vision");
  assert.strictEqual(state.execution, execution);
  await assert.rejects(
    harness({
      execution: { executionMode: "BYOK", providerModel: "my-vision" },
    }).run(),
    /PPT_VISION_BYOK_EXECUTION_INVALID/,
  );
});
