import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { agentToolTurnPreflights } from "@sourceweft/agent-tool-registry";
import type {
  AgentToolModelProfileView,
  AgentToolTurnPreflightInput,
} from "@sourceweft/contracts/agent-tools";
import {
  buildEffectiveToolsSelection,
  buildRuntimeTools,
} from "../../turn/tool-selection";
import {
  mergeSelectedSkillRuntimeTools,
  resolveToolPermissions,
} from "../../turn/thread-command-tools";
import type { CapabilityAgentToolsForTurnInput } from "./types";
import { resolveSelectedSkillRuntimeContract } from "../../turn/active-skill-runtime";
import { resolveActiveSkillPromptIds } from "../../turn/invoked-skills";
import { resolveCapabilitySkillRuntimeWorkflow } from "../../turn/capability-command-workflows";
import type { EnabledSkillDescriptor } from "../../../skills/types";

const hostMocks = vi.hoisted(() => ({
  getClient: vi.fn(async () => {
    throw new Error("Binding must not execute a model request");
  }),
  publishArtifact: vi.fn(async () => {
    throw new Error("Binding must not publish an artifact");
  }),
}));

// Keep all actual capability discovery, factories and host service wiring.
// Only external execution is stubbed; no model/storage request is needed to bind.
vi.mock("../../../sources/web-provider", () => ({
  createDefaultWebProvider: async () => null,
}));
vi.mock("./host-services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-services")>();
  return {
    ...actual,
    createCapabilityAgentToolHostServices: (
      ...args: Parameters<typeof actual.createCapabilityAgentToolHostServices>
    ) => {
      const services = actual.createCapabilityAgentToolHostServices(...args);
      return {
        ...services,
        modelGateway: {
          ...services.modelGateway,
          getClient: hostMocks.getClient,
        },
        artifacts: {
          ...services.artifacts,
          publishArtifact: hostMocks.publishArtifact,
        },
      };
    },
  };
});

const { createCapabilityAgentToolsForTurn } = await import("./index");

const imageProfile: AgentToolModelProfileView = {
  gatewayConfigId: "image-gateway",
  profileAlias: "image-default",
  modelAlias: "gpt-image-1",
  configJson: { providerKind: "openai" },
};

async function prepareImageBinding(
  input: {
    profile?: AgentToolModelProfileView;
    selection?: Record<string, unknown>;
    execution?: unknown;
    lookupError?: Error;
    invokedSkillIds?: string[];
    sandboxAvailable?: boolean;
  } = {},
) {
  const preflight = agentToolTurnPreflights().find(
    (entry) => entry.name === "generate_image",
  );
  assert.ok(preflight);
  const skillIds = ["builtin:image-generate", "builtin:ppt-deck"];
  const enabledSkills: EnabledSkillDescriptor[] = [
    "image-generate",
    "ppt-deck",
  ].map((name) => ({
    name,
    workspaceSkillId: `builtin:${name}`,
    selectionId: `builtin:${name}`,
    sourceType: "builtin",
    version: "1.0.0",
    description: name,
    files: [],
    defaultEnabled: true,
  }));
  const invokedSkillIds = resolveActiveSkillPromptIds({
    enabledSkills,
    invokedSkillIds: input.invokedSkillIds,
    selectedSkillIds: skillIds,
  });
  const workflows = await Promise.all(
    enabledSkills.map(async (skill) => {
      const workflow = await resolveCapabilitySkillRuntimeWorkflow(skill.name);
      assert.ok(
        workflow,
        `Real builtin workflow ${skill.name} must be discovered`,
      );
      return [skill.name, workflow] as const;
    }),
  );
  const selectedSkillRuntime = resolveSelectedSkillRuntimeContract({
    selectedSkills: enabledSkills,
    command: null,
    invokedSkillIds,
    skillRuntimeWorkflows: new Map(workflows),
  });
  const baseTools = mergeSelectedSkillRuntimeTools(
    {
      skillIds,
      ...(input.invokedSkillIds
        ? { invokedSkillIds: input.invokedSkillIds }
        : {}),
      ...(input.selection ? { generate_image: input.selection } : {}),
    },
    selectedSkillRuntime,
  );
  const services: AgentToolTurnPreflightInput["services"] = {
    resolveProfile: async (request) => {
      if (input.lookupError) throw input.lookupError;
      if (!input.profile && request.required) {
        throw new Error(
          "Default image model gateway profile is not configured",
        );
      }
      return input.profile ?? null;
    },
    synthesizeByokProfile: (request) => ({
      gatewayConfigId: "",
      profileAlias: request.profileAlias,
      modelAlias: request.modelAlias,
      configJson: { providerKind: request.providerKind },
    }),
  };
  const result = await preflight.turnPreflight.run({
    toolName: preflight.name,
    modelKind: preflight.modelKind,
    defaultEnabled: preflight.defaultEnabled,
    selection: baseTools?.generate_image,
    command: null,
    enabledSkills: [{ tools: ["generate_image"] }],
    execution: input.execution,
    threadProfileAlias: null,
    services,
  });
  assert.ok(result);
  const effectiveTools = buildEffectiveToolsSelection({
    baseTools,
    skillIds,
    invokedSkillIds,
    toolOverrides:
      result.selection !== undefined
        ? { generate_image: result.selection }
        : {},
    webAccessEnabled: false,
  });
  const toolPermissions = resolveToolPermissions({
    command: null,
    selectedSkillRuntime,
    tools: effectiveTools,
  });
  const prepared = {
    workspace: { id: "workspace-1", organizationId: "team-1" },
    thread: { id: "thread-1" },
    userId: "user-1",
    userMessage: { id: "message-1", metadata: result.messageMetadata },
    effectiveTools,
    enabledSkills,
    invokedSkillIds,
    command: null,
    invocation: null,
    commandSuccessCriteria: selectedSkillRuntime.successCriteria ?? {
      kind: "none",
    },
    toolPermissions,
    runtimeTools: buildRuntimeTools({ tools: effectiveTools, toolPermissions }),
    turnState: { generate_image: result.state },
    webAccessEnabled: false,
  } as unknown as CapabilityAgentToolsForTurnInput["prepared"];
  return {
    result,
    prepared,
    bind: () =>
      createCapabilityAgentToolsForTurn({
        prepared,
        billing: {} as never,
        runtime: {} as never,
        filesystemBackend: { backend: {} } as never,
        sandboxRuntime: input.sandboxAvailable
          ? ({
              trustedHost: {
                downloadCurrentFile: async () => new Uint8Array(),
              },
            } as never)
          : null,
      }),
  };
}

beforeEach(() => vi.clearAllMocks());

test("default skill image availability agrees with strict host bindings when no image profile exists", async () => {
  const { prepared, result, bind } = await prepareImageBinding();
  assert.equal(prepared.runtimeTools.generate_image?.shouldBind, false);
  assert.equal(prepared.toolPermissions.generate_image, "deny");
  assert.deepEqual(
    (result.messageMetadata?.artifactIntent as { warnings: string[] }).warnings,
    ["image_model_unavailable"],
  );
  const bound = await bind();
  assert.deepEqual(bound.tools.map((tool) => tool.name).sort(), [
    "publish_artifact",
    "search_sources",
  ]);
  assert.ok(bound.promptProviders.length > 0, "real image factory was loaded");
  assert.equal(hostMocks.getClient.mock.calls.length, 0);
});

test("configured image capability binds through the real host and package factory", async () => {
  const { prepared, bind } = await prepareImageBinding({
    profile: imageProfile,
  });
  assert.equal(prepared.runtimeTools.generate_image?.shouldBind, true);
  assert.deepEqual((await bind()).tools.map((tool) => tool.name).sort(), [
    "generate_image",
    "publish_artifact",
    "search_sources",
  ]);
});

test("BYOK image capability binds without a global image profile", async () => {
  const { prepared, bind } = await prepareImageBinding({
    execution: {
      executionMode: "BYOK",
      byokModelId: "byok-image-1",
      credentialId: "credential-1",
      modelAlias: "gpt-image-1",
      providerHint: "openai",
      byok: { provider: "openai", apiKey: "test-credential" },
    },
  });
  assert.equal(prepared.runtimeTools.generate_image?.shouldBind, true);
  assert.deepEqual((await bind()).tools.map((tool) => tool.name).sort(), [
    "generate_image",
    "publish_artifact",
    "search_sources",
  ]);
});

test("disabled image selection remains disabled despite skill permission defaults", async () => {
  const { prepared, bind } = await prepareImageBinding({
    profile: imageProfile,
    selection: { enabled: false },
  });
  assert.equal(prepared.runtimeTools.generate_image?.shouldBind, false);
  assert.deepEqual((await bind()).tools.map((tool) => tool.name).sort(), [
    "publish_artifact",
    "search_sources",
  ]);
});

test("explicit image requests and profile service errors still fail before binding", async () => {
  await assert.rejects(
    prepareImageBinding({ selection: { enabled: true, mode: "generate" } }),
    /Default image model gateway profile is not configured/,
  );
  const lookupError = new Error("catalog query failed");
  await assert.rejects(
    prepareImageBinding({ lookupError }),
    (error) => error === lookupError,
  );
});

test("the real image skill invocation chip requires its image output without a command or invocation envelope", async () => {
  await assert.rejects(
    prepareImageBinding({ invokedSkillIds: ["builtin:image-generate"] }),
    /Default image model gateway profile is not configured/,
  );
  const { prepared, bind } = await prepareImageBinding({
    profile: imageProfile,
    invokedSkillIds: ["builtin:image-generate"],
  });
  assert.equal(prepared.runtimeTools.generate_image?.options.mode, "generate");
  assert.deepEqual((await bind()).tools.map((tool) => tool.name).sort(), [
    "generate_image",
    "publish_artifact",
    "search_sources",
  ]);
});

test("an invoked PPT workflow keeps its helper image capability optional", async () => {
  const { prepared, bind } = await prepareImageBinding({
    invokedSkillIds: ["builtin:ppt-deck"],
    sandboxAvailable: true,
  });
  assert.equal(prepared.runtimeTools.generate_image?.options.mode, undefined);
  assert.equal(prepared.runtimeTools.generate_image?.shouldBind, false);
  assert.equal(prepared.runtimeTools.publish_artifact?.shouldBind, true);
  assert.deepEqual((await bind()).tools.map((tool) => tool.name).sort(), [
    "publish_artifact",
    "review_deck_visuals",
    "search_sources",
  ]);
});

test("the real PPT invocation chip fails explicitly when sandbox is unavailable", async () => {
  const { bind } = await prepareImageBinding({
    invokedSkillIds: ["builtin:ppt-deck"],
  });
  await assert.rejects(
    bind(),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SANDBOX_RUNTIME_UNAVAILABLE" &&
      error.message.includes("review_deck_visuals"),
  );
});

test("strict host validation still rejects a missing binding for an available image capability", async () => {
  const { prepared, bind } = await prepareImageBinding({
    profile: imageProfile,
  });
  // Simulate a broken preflight/factory handoff without changing the selected
  // tool: a required tool must still be rejected, never silently omitted.
  const state = prepared.turnState.generate_image as { imageProfile: unknown };
  state.imageProfile = null;
  await assert.rejects(
    bind(),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CAPABILITY_TOOL_BINDING_MISSING",
  );
});
