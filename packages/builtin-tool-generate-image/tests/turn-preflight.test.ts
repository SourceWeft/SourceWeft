import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentToolByokModelProfileRequest,
  AgentToolModelProfileRequest,
  AgentToolModelProfileView,
  AgentToolTurnPreflightInput,
} from "@sourceweft/contracts/agent-tools";
import { createCapabilityAgentTools } from "../src/agent-tools";
import {
  generateImageTurnPreflight,
  type GenerateImageTurnState,
} from "../src/turn-preflight";

const profile: AgentToolModelProfileView = {
  gatewayConfigId: "image-gateway",
  profileAlias: "image-default",
  modelAlias: "gpt-image-1",
  configJson: { providerKind: "openai" },
};

function createPreflightHarness(
  options: {
    profile?: AgentToolModelProfileView;
    lookupError?: Error;
  } = {},
) {
  const requests: AgentToolModelProfileRequest[] = [];
  const synthesized: AgentToolByokModelProfileRequest[] = [];
  return {
    requests,
    synthesized,
    run: async (overrides: Partial<AgentToolTurnPreflightInput> = {}) => {
      const result = await generateImageTurnPreflight.run({
        toolName: "generate_image",
        modelKind: "image",
        selection: {
          enabled: true,
          config: { aspectRatio: "auto", quality: "auto", style: "auto" },
        },
        command: null,
        enabledSkills: [{ tools: ["generate_image"] }],
        defaultEnabled: false,
        execution: undefined,
        threadProfileAlias: null,
        services: {
          resolveProfile: async (request) => {
            requests.push(request);
            if (options.lookupError) throw options.lookupError;
            if (!options.profile && request.required) {
              throw new Error(
                "Default image model gateway profile is not configured",
              );
            }
            return options.profile ?? null;
          },
          synthesizeByokProfile: (request) => {
            synthesized.push(request);
            return {
              gatewayConfigId: "",
              profileAlias: request.profileAlias,
              modelAlias: request.modelAlias,
              configJson: { providerKind: request.providerKind },
            };
          },
        },
        ...overrides,
      });
      assert.ok(result);
      return { ...result, state: result.state as GenerateImageTurnState };
    },
  };
}

function bindTools(state: GenerateImageTurnState) {
  const unexpectedCall = async (): Promise<never> => {
    throw new Error("Binding must not call the gateway or artifact writer");
  };
  return createCapabilityAgentTools({
    context: {
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
      turnState: { generate_image: state },
    },
    services: {
      modelGateway: { getClient: unexpectedCall },
      artifacts: {
        publishArtifact: unexpectedCall,
        openArtifact: unexpectedCall,
        republishArtifact: unexpectedCall,
        createPendingArtifact: unexpectedCall,
        createReadyArtifact: unexpectedCall,
        findArtifact: unexpectedCall,
        findReusableArtifact: unexpectedCall,
      },
    },
  }).tools;
}

test("default skill image options do not require an image profile for ordinary chat", async () => {
  const harness = createPreflightHarness();
  const result = await harness.run();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.required, false);
  assert.equal(result.state.imageProfile, null);
  assert.equal((result.selection as { enabled: boolean }).enabled, false);
  assert.equal(result.state.selection?.enabled, true);
  assert.equal(result.state.artifactIntent.shouldInjectTool, false);
  assert.deepEqual(result.state.artifactIntent.warnings, [
    "image_model_unavailable",
  ]);
  assert.deepEqual(bindTools(result.state), []);
});

test("image capability enabled without a skill remains optional", async () => {
  const harness = createPreflightHarness();
  const result = await harness.run({ enabledSkills: [] });
  assert.equal(harness.requests[0]?.required, false);
  assert.deepEqual(result.state.artifactIntent.warnings, [
    "image_model_unavailable",
  ]);
});

test("an available default image profile still binds the image tool", async () => {
  const harness = createPreflightHarness({ profile });
  const result = await harness.run();
  assert.equal(result.state.imageProfile?.profile, profile);
  assert.equal((result.selection as { enabled: boolean }).enabled, true);
  assert.equal(result.state.artifactIntent.shouldInjectTool, true);
  assert.equal(bindTools(result.state).length, 1);
});

for (const [name, overrides] of [
  ["generate mode", { selection: { enabled: true, mode: "generate" } }],
  [
    "same-name tool command",
    { command: { kind: "tool", toolName: "generate_image" } },
  ],
  ["explicit default profile", { requestedProfileAlias: null }],
] as const) {
  test(`${name} still fails when the requested image profile is unavailable`, async () => {
    const harness = createPreflightHarness();
    await assert.rejects(
      harness.run(overrides),
      /Default image model gateway profile is not configured/,
    );
    assert.equal(harness.requests[0]?.required, true);
  });
}

test("explicit model selection and thread profile precedence are preserved", async () => {
  const harness = createPreflightHarness({ profile });
  const result = await harness.run({
    selection: { enabled: true, modelAlias: "chosen-image" },
    threadProfileAlias: "thread-image",
    requestedProfileAlias: "request-image",
  });
  assert.deepEqual(harness.requests, [
    {
      profileAlias: undefined,
      modelAlias: "chosen-image",
      required: false,
    },
  ]);
  assert.equal(result.state.imageProfile?.profile, profile);
});

test("an explicit profile keeps the existing required default lookup when absent", async () => {
  const harness = createPreflightHarness();
  await assert.rejects(
    harness.run({ requestedProfileAlias: "missing-profile" }),
    /not configured/,
  );
  assert.equal(harness.requests[0]?.profileAlias, "missing-profile");
  assert.equal(harness.requests[0]?.required, false);
  assert.deepEqual(harness.requests[1], { required: true });
});

test("an unrelated tool command does not make a stale image selection mandatory", async () => {
  const harness = createPreflightHarness();
  const result = await harness.run({
    command: { kind: "tool", toolName: "publish_artifact" },
    selection: { enabled: true, mode: "generate" },
  });
  assert.equal(harness.requests[0]?.required, false);
  assert.equal(result.state.artifactIntent.shouldInjectTool, false);
});

test("user-disabled image tools do not perform profile or BYOK lookups", async () => {
  const harness = createPreflightHarness();
  const result = await harness.run({
    selection: { enabled: false, mode: "generate" },
    execution: {
      executionMode: "BYOK",
      modelAlias: "gpt-image-1",
      providerHint: "openai",
    },
  });
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(harness.synthesized, []);
  assert.equal(result.state.artifactIntent.shouldInjectTool, false);
});

test("resolved BYOK execution remains usable without a global image profile", async () => {
  const harness = createPreflightHarness();
  const execution = {
    executionMode: "BYOK",
    modelAlias: "gpt-image-1",
    providerHint: "openai",
    byokModelId: "byok-image-1",
    credentialId: "credential-1",
    byok: { provider: "openai", apiKey: "test-credential" },
  };
  const result = await harness.run({ execution });
  assert.equal(
    harness.requests.every((request) => request.required === false),
    true,
  );
  assert.deepEqual(harness.synthesized, [
    {
      profileAlias: "byok:image:byok-image-1",
      modelAlias: "gpt-image-1",
      providerKind: "openai",
    },
  ]);
  assert.deepEqual(result.state.selection?.execution, execution);
  assert.equal(result.state.artifactIntent.shouldInjectTool, true);
  assert.equal(bindTools(result.state).length, 1);
});

test("optional profile lookup errors propagate instead of being treated as missing configuration", async () => {
  const failure = new Error("catalog database unavailable");
  const harness = createPreflightHarness({ lookupError: failure });
  await assert.rejects(harness.run(), (error) => error === failure);
  assert.equal(harness.requests.length, 1);
});
