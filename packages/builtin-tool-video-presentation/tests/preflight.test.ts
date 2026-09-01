import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentToolLlmExecutionConfig,
  AgentToolModelProfileView,
} from "@sourceweft/contracts/agent-tools";
import {
  resolveVideoGatewayExecution,
  videoModelSemanticIdentity,
} from "../src/agent/common";
import { createVideoModelTurnPreflight } from "../src/agent/preflight";

function profile(
  profileAlias: string,
  modelAlias = `${profileAlias}-model`,
): AgentToolModelProfileView {
  return {
    gatewayConfigId: `${profileAlias}-gateway`,
    profileAlias,
    modelAlias,
  };
}

async function runPreflight(input: {
  requestedProfileAlias?: string | null;
  threadProfileAlias?: string | null;
  skillProfileAlias?: string | null;
  execution?: AgentToolLlmExecutionConfig;
}) {
  const requests: Array<{
    profileAlias?: string | null;
    modelAlias?: string | null;
  }> = [];
  const synthesized: Array<{
    profileAlias: string;
    modelAlias: string;
    providerKind?: string | null;
  }> = [];
  const result = await createVideoModelTurnPreflight({ required: true }).run({
    toolName: "generate_video_assets",
    modelKind: "image",
    selection: undefined,
    command: null,
    enabledSkills: [
      {
        tools: ["generate_video_assets"],
        models: { image: input.skillProfileAlias },
      },
    ],
    defaultEnabled: false,
    execution: input.execution,
    ...(Object.hasOwn(input, "requestedProfileAlias")
      ? { requestedProfileAlias: input.requestedProfileAlias }
      : {}),
    threadProfileAlias: input.threadProfileAlias ?? null,
    services: {
      resolveProfile: async (request) => {
        requests.push(request);
        return profile(
          request.profileAlias ?? request.modelAlias ?? "image-default",
        );
      },
      synthesizeByokProfile: (request) => {
        synthesized.push(request);
        return profile(request.profileAlias, request.modelAlias);
      },
    },
  });
  return { requests, result, synthesized };
}

test("profile precedence is request profile, request model, thread, skill, then default", async () => {
  const requested = await runPreflight({
    requestedProfileAlias: "request-profile",
    threadProfileAlias: "thread-profile",
    skillProfileAlias: "skill-profile",
  });
  assert.deepEqual(requested.requests[0], {
    profileAlias: "request-profile",
    required: true,
  });

  const requestedModel = await runPreflight({
    execution: { executionMode: "GLOBAL", modelAlias: "request-model" },
    threadProfileAlias: "thread-profile",
    skillProfileAlias: "skill-profile",
  });
  assert.deepEqual(requestedModel.requests[0], {
    modelAlias: "request-model",
    required: true,
  });

  const threaded = await runPreflight({
    threadProfileAlias: "thread-profile",
    skillProfileAlias: "skill-profile",
  });
  assert.deepEqual(threaded.requests[0], {
    profileAlias: "thread-profile",
    required: true,
  });

  const skilled = await runPreflight({ skillProfileAlias: "skill-profile" });
  assert.deepEqual(skilled.requests[0], {
    profileAlias: "skill-profile",
    required: true,
  });

  const defaulted = await runPreflight({ requestedProfileAlias: null });
  assert.deepEqual(defaulted.requests[0], { required: true });
});

test("BYOK preflight wins over configured profiles and preserves resolved execution", async () => {
  const execution: AgentToolLlmExecutionConfig = {
    executionMode: "BYOK",
    modelAlias: "My image model",
    providerModel: "provider/image-current",
    providerHint: "openrouter",
    byokModelId: "byok-model-1",
    credentialId: "credential-1",
    byok: {
      provider: "openrouter",
      providerKind: "openrouter",
      apiKey: "secret",
      baseUrl: "https://router.example/v1",
      defaultHeaders: { "x-tenant": "one" },
    },
  };
  const { requests, result, synthesized } = await runPreflight({
    requestedProfileAlias: "request-profile",
    threadProfileAlias: "thread-profile",
    skillProfileAlias: "skill-profile",
    execution,
  });

  assert.equal(requests.length, 0);
  assert.deepEqual(synthesized, [
    {
      profileAlias: "byok:image:byok-model-1:credential-1",
      modelAlias: "provider/image-current",
      providerKind: "openrouter",
    },
  ]);
  const state = result?.state as {
    profile: AgentToolModelProfileView;
    execution: AgentToolLlmExecutionConfig;
  };
  assert.deepEqual(state.execution, execution);
  assert.equal(state.profile.modelAlias, "provider/image-current");
});

test("gateway execution and semantic identity carry provider route without secrets", () => {
  const resolvedProfile = profile(
    "byok:image:byok-model-1:credential-1",
    "provider/image-current",
  );
  const execution: AgentToolLlmExecutionConfig = {
    executionMode: "BYOK",
    providerModel: "provider/image-current",
    providerHint: "openrouter",
    byokModelId: "byok-model-1",
    credentialId: "credential-1",
    byok: {
      provider: "openrouter",
      providerKind: "openrouter",
      apiKey: "secret",
      baseUrl: "https://router.example/v1",
      defaultHeaders: { Authorization: "also-secret" },
    },
  };

  assert.deepEqual(resolveVideoGatewayExecution(resolvedProfile, execution), {
    model: "provider/image-current",
    fallbackPolicy: "none",
    executionMode: "BYOK",
    providerHint: "openrouter",
    byokModelId: "byok-model-1",
    credentialId: "credential-1",
    byok: execution.byok,
  });
  const identity = videoModelSemanticIdentity(resolvedProfile, execution);
  assert.deepEqual(identity, {
    gatewayConfigId: resolvedProfile.gatewayConfigId,
    profileAlias: resolvedProfile.profileAlias,
    model: "provider/image-current",
    executionMode: "BYOK",
    providerHint: "openrouter",
    byokModelId: "byok-model-1",
    credentialId: "credential-1",
    byokProvider: "openrouter",
    byokProviderKind: "openrouter",
    byokBaseUrl: "https://router.example/v1",
  });
  assert.equal(JSON.stringify(identity).includes("secret"), false);
});
