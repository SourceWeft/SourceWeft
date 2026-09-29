import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemModel: vi.fn(),
  identity: vi.fn(),
}));
vi.mock("../../shared/model-gateway/system-client", () => ({
  withSystemModel: mocks.withSystemModel,
  resolveSystemModelIdentity: mocks.identity,
}));

import { overviewModelConfigurationKey } from "./keys";
import {
  createOverviewModelCall,
  resolveOverviewModelConfigurationKey,
} from "./model";

const spec = {
  purpose: "mcp_market.overview" as const,
  subjectRef: (id: string) => `thing-version:${id}`,
  output: {
    name: "thing_overview",
    description: "A thing.",
    schema: { type: "object" },
    maxTokens: 123,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

test("the call goes through the system model under the kind's purpose and output spec", async () => {
  const complete = vi.fn(async () => ({
    structuredOutput: { ok: true },
    providerModel: "vendor/model",
    model: "system:market",
  }));
  mocks.withSystemModel.mockImplementation(
    async (_context: unknown, run: (chat: unknown) => Promise<unknown>) =>
      run({ complete }),
  );
  const result = await createOverviewModelCall(spec)({
    prompt: { system: "s", user: "u" },
    versionId: "v",
    scopeId: "scope",
  });
  expect(result).toEqual({ output: { ok: true }, model: "vendor/model" });
  expect(mocks.withSystemModel.mock.calls[0]![0]).toEqual({
    purpose: "mcp_market.overview",
    subjectRef: "thing-version:v",
    scopeId: "scope",
  });
  expect(complete).toHaveBeenCalledWith({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    structuredOutput: {
      name: "thing_overview",
      description: "A thing.",
      schema: { type: "object" },
    },
    thinking: { mode: "off", enabled: false, includeReasoning: false },
    maxTokens: 123,
    temperature: 0.2,
  });
});

test("a prompt that carries its own schema is answered in that schema", async () => {
  const complete = vi.fn(async (_input: unknown) => ({
    structuredOutput: { ok: true },
    model: "system:market",
  }));
  mocks.withSystemModel.mockImplementation(
    async (_context: unknown, run: (chat: unknown) => Promise<unknown>) =>
      run({ complete }),
  );
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: { evidence: { type: "string", enum: ["D1", "R2"] } },
    required: ["evidence"],
  };
  await createOverviewModelCall(spec)({
    prompt: { system: "s", user: "u", outputSchema },
    versionId: "v",
    scopeId: "scope",
  });
  expect(complete.mock.calls[0]![0]).toMatchObject({
    // The prompt's messages only: the schema is not a message.
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    structuredOutput: {
      name: "thing_overview",
      description: "A thing.",
      schema: outputSchema,
    },
    maxTokens: 123,
  });
});

test("a text answer is handed to the kind's parser as text", async () => {
  mocks.withSystemModel.mockImplementation(
    async (_context: unknown, run: (chat: unknown) => Promise<unknown>) =>
      run({
        complete: async () => ({
          model: "system:market",
          raw: { content: ["{", { text: '"a":1' }, { other: 1 }, "}"] },
        }),
      }),
  );
  expect(
    await createOverviewModelCall(spec)({
      prompt: { system: "s", user: "u" },
      versionId: "v",
      scopeId: "scope",
    }),
  ).toEqual({ output: '{"a":1}', model: "system:market" });
});

test("the model configuration key follows the system model, and is null without one", async () => {
  const identity = {
    provider: "openrouter",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiVersion: null,
    model: "a/b",
  };
  mocks.identity.mockResolvedValue(identity);
  expect(await resolveOverviewModelConfigurationKey()).toBe(
    overviewModelConfigurationKey(identity),
  );
  mocks.identity.mockResolvedValue(null);
  expect(await resolveOverviewModelConfigurationKey()).toBeNull();
});
