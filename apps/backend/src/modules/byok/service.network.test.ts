import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  addressChecks: true,
  allowedOrigins: [] as string[],
  systemProviders: [] as Array<{ baseUrl: string; isActive: boolean }>,
  select: vi.fn(),
  where: vi.fn(),
  requireWorkspace: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  createCredential: vi.fn(),
  credential: vi.fn(),
  runtimeModel: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: {
    get endpointAddressChecksEnabled() {
      return state.addressChecks;
    },
    get llmAllowedInternalOrigins() {
      return state.allowedOrigins;
    },
    mcpAllowedInternalOrigins: ["http://127.0.0.1:9000"],
    openrouterApiKey: "system-provider-secret",
    openrouterEnabled: true,
  },
}));
vi.mock("@sourceweft/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sourceweft/db")>();
  return { ...actual, db: { select: state.select } };
});
vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: state.requireWorkspace,
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: state.encrypt,
  decryptTeamSecret: state.decrypt,
}));
vi.mock("./repository", () => ({
  createByokCredentialRecord: state.createCredential,
  getByokCredentialWithSecretRecord: state.credential,
  getByokModelRuntimeRecord: state.runtimeModel,
  createByokModelRecord: vi.fn(),
  deleteByokCredentialRecord: vi.fn(),
  deleteByokModelRecord: vi.fn(),
  listByokCredentialRecords: vi.fn(),
  listByokModelRecords: vi.fn(),
}));
vi.mock("../../shared/model-gateway/byok-provider-resolver", () => ({
  listCustomByokProviders: vi.fn(),
}));
vi.mock("../../shared/model-gateway/runtime", () => ({
  loadRoutedGatewayConfig: vi.fn(),
}));
vi.mock("../../shared/model-gateway", () => ({
  resolveModelCapabilitiesFromLitellm: vi.fn(),
}));
vi.mock("../../shared/model-gateway/model-catalog/registry", () => ({
  modelCatalog: {},
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ContentByokService } from "./service";
import { ContentError } from "../content/errors";

const service = new ContentByokService();
const origin = "http://127.0.0.1:11434";
const scope = { workspaceId: "workspace", userId: "user" };
const recordScope = { ...scope, teamId: "team" };

function credential(baseUrl: string | null = `${origin}/v1`) {
  return {
    id: "credential",
    credentialAlias: "personal-local",
    providerName: "local",
    providerKind: "openai-compatible",
    apiKeyEncrypted: "encrypted-user-secret",
    baseUrl,
    defaultHeaders: { "X-Tenant": "tenant-a" },
  };
}

function runtimeModel(baseUrl: string | null = `${origin}/v1`) {
  return {
    id: "model",
    credentialId: "credential",
    providerName: "local",
    modelName: "local-chat",
    displayName: "Local chat",
    modelType: "llm",
    capabilities: null,
    credential: credential(baseUrl),
  };
}

const createInput = {
  ...scope,
  providerName: "local",
  credentialAlias: "personal-local",
  providerKind: "openai-compatible",
  apiKey: "user-secret",
  baseUrl: `${origin}/v1/`,
  defaultHeaders: { "X-Tenant": "tenant-a" },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.addressChecks = true;
  state.allowedOrigins = [];
  state.systemProviders = [];
  state.requireWorkspace.mockResolvedValue({
    id: "workspace",
    organizationId: "team",
  });
  state.encrypt.mockResolvedValue("encrypted-user-secret");
  state.decrypt.mockResolvedValue("user-secret");
  state.credential.mockResolvedValue(credential());
  state.runtimeModel.mockResolvedValue(runtimeModel());
  state.createCredential.mockImplementation(async (input) => ({
    id: "credential",
    ...input,
  }));
  state.where.mockImplementation(async () =>
    state.systemProviders.map(({ baseUrl }) => ({ baseUrl })),
  );
  state.select.mockImplementation(() => ({
    from: () => ({ innerJoin: () => ({ where: state.where }) }),
  }));
  vi.stubEnv("OPENAI_API_KEY", "ambient-global-secret");
  vi.stubEnv("OPENROUTER_API_KEY", "system-provider-secret");
});

afterEach(() => vi.unstubAllEnvs());

describe("BYOK endpoint creation", () => {
  test("development saves an unlisted fake-IP endpoint with only the user's encrypted credential", async () => {
    state.addressChecks = false;
    const baseUrl = "http://198.18.0.20:8000/v1";
    await expect(
      service.createByokCredential({ ...createInput, baseUrl }),
    ).resolves.toMatchObject({
      item: { baseUrl, apiKeyEncrypted: "encrypted-user-secret" },
    });
    expect(state.encrypt).toHaveBeenCalledExactlyOnceWith(
      "user-secret",
      "team",
    );
  });
  test.each([true, false])(
    "accepts a System endpoint with GLOBAL enabled=%s",
    async (isActive) => {
      state.systemProviders = [{ baseUrl: `${origin}/v1`, isActive }];

      const result = await service.createByokCredential(createInput);

      expect(result.item.baseUrl).toBe(`${origin}/v1`);
      expect(state.encrypt).toHaveBeenCalledExactlyOnceWith(
        "user-secret",
        "team",
      );
      expect(state.createCredential).toHaveBeenCalledExactlyOnceWith({
        ...recordScope,
        providerName: "local",
        credentialAlias: "personal-local",
        providerKind: "openai-compatible",
        apiKeyEncrypted: "encrypted-user-secret",
        baseUrl: `${origin}/v1`,
        defaultHeaders: { "X-Tenant": "tenant-a" },
        metadata: undefined,
      });
      // The real query must select non-secret definitions from the active config
      // version without filtering on the System Provider's GLOBAL activation.
      expect(Object.keys(state.select.mock.calls[0]![0])).toEqual(["baseUrl"]);
      const query = new PgDialect().sqlToQuery(state.where.mock.calls[0]![0]);
      expect(query.sql).toBe(
        '"model_gateway_config_versions"."is_active" = $1',
      );
      expect(query.params).toEqual([true]);
    },
  );

  test("accepts an env-authorized custom origin without a System definition", async () => {
    state.allowedOrigins = [origin];
    await expect(
      service.createByokCredential(createInput),
    ).resolves.toMatchObject({
      item: {
        baseUrl: `${origin}/v1`,
        apiKeyEncrypted: "encrypted-user-secret",
      },
    });
  });

  test.each([
    ["unlisted local origin", `${origin}/v1`],
    ["MCP-only permission", "http://127.0.0.1:9000/v1"],
    ["different port", "http://127.0.0.1:11435/v1"],
    ["metadata address", "http://169.254.169.254/v1"],
  ])(
    "rejects %s before storing or encrypting credentials",
    async (_label, baseUrl) => {
      state.allowedOrigins = [
        "http://127.0.0.1:11436",
        "http://169.254.169.254",
      ];
      await expect(
        service.createByokCredential({ ...createInput, baseUrl }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "BYOK_PROVIDER_ENDPOINT_NOT_ALLOWED",
      });
      expect(state.encrypt).not.toHaveBeenCalled();
      expect(state.createCredential).not.toHaveBeenCalled();
    },
  );

  test("requires workspace authorization before reading policy or storing a secret", async () => {
    state.requireWorkspace.mockRejectedValue(
      new ContentError(403, "FORBIDDEN", "Forbidden"),
    );
    await expect(
      service.createByokCredential(createInput),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(state.select).not.toHaveBeenCalled();
    expect(state.encrypt).not.toHaveBeenCalled();
    expect(state.createCredential).not.toHaveBeenCalled();
  });
});

describe("BYOK discovery and execution", () => {
  test("development discovers an unlisted local endpoint without changing credential ownership", async () => {
    state.addressChecks = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: [{ id: "local-chat" }] }));
    await expect(
      service.listByokModelCandidates({ ...scope, credentialId: "credential" }),
    ).resolves.toEqual({
      items: [{ modelId: "local-chat", displayName: "local-chat" }],
    });
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`${origin}/v1/models`);
    expect(request.headers.get("authorization")).toBe("Bearer user-secret");
    expect(state.decrypt).toHaveBeenCalledExactlyOnceWith(
      "encrypted-user-secret",
      "team",
    );
  });
  test("discovers a disabled System's internal catalog using the decrypted BYOK key", async () => {
    state.systemProviders = [{ baseUrl: `${origin}/v1`, isActive: false }];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ data: [{ id: "local-chat" }, { id: "local-embed" }] }),
      );

    await expect(
      service.listByokModelCandidates({ ...scope, credentialId: "credential" }),
    ).resolves.toEqual({
      items: [
        { modelId: "local-chat", displayName: "local-chat" },
        { modelId: "local-embed", displayName: "local-embed" },
      ],
    });
    expect(state.credential).toHaveBeenCalledExactlyOnceWith({
      ...recordScope,
      credentialId: "credential",
    });
    expect(state.decrypt).toHaveBeenCalledExactlyOnceWith(
      "encrypted-user-secret",
      "team",
    );
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request).toBeInstanceOf(Request);
    expect(request.url).toBe(`${origin}/v1/models`);
    expect(request.headers.get("authorization")).toBe("Bearer user-secret");
    expect(request.headers.get("x-tenant")).toBe("tenant-a");
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      dispatcher: expect.anything(),
    });
  });

  test("resolves an env-authorized custom execution endpoint with only its BYOK credential", async () => {
    state.allowedOrigins = [origin];
    const result = await service.resolveByokModelExecution({
      ...scope,
      byokModelId: "model",
    });
    expect(result).toMatchObject({
      apiKey: "user-secret",
      baseUrl: `${origin}/v1`,
      defaultHeaders: { "X-Tenant": "tenant-a" },
      providerKind: "openai-compatible",
      modelName: "local-chat",
    });
    expect(state.runtimeModel).toHaveBeenCalledExactlyOnceWith({
      ...recordScope,
      modelId: "model",
    });
    expect(state.decrypt).toHaveBeenCalledExactlyOnceWith(
      "encrypted-user-secret",
      "team",
    );
  });

  test("resolves a disabled System's internal endpoint without borrowing its activation or key", async () => {
    state.systemProviders = [{ baseUrl: `${origin}/v1`, isActive: false }];
    await expect(
      service.resolveByokModelExecution({ ...scope, byokModelId: "model" }),
    ).resolves.toMatchObject({
      baseUrl: `${origin}/v1`,
      apiKey: "user-secret",
    });
  });

  const paths = [
    {
      name: "discovery",
      run: () =>
        service.listByokModelCandidates({
          ...scope,
          credentialId: "credential",
        }),
      lookup: state.credential,
      missingCode: "BYOK_CREDENTIAL_NOT_FOUND",
    },
    {
      name: "execution",
      run: () =>
        service.resolveByokModelExecution({ ...scope, byokModelId: "model" }),
      lookup: state.runtimeModel,
      missingCode: "BYOK_MODEL_NOT_FOUND",
    },
  ];

  for (const path of paths) {
    test(`${path.name} revalidates a formerly saved, now unlisted internal origin`, async () => {
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(path.run()).rejects.toMatchObject({
        code: "BYOK_PROVIDER_ENDPOINT_NOT_ALLOWED",
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    test(`${path.name} cannot use global credentials when the authorized repository returns no record`, async () => {
      path.lookup.mockResolvedValue(null);
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(path.run()).rejects.toMatchObject({
        statusCode: 404,
        code: path.missingCode,
      });
      expect(state.decrypt).not.toHaveBeenCalled();
      expect(state.select).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    test.each([null, ""])(
      `${path.name} cannot use global credentials when decryption returns %s`,
      async (value) => {
        state.decrypt.mockResolvedValue(value);
        const fetch = vi.spyOn(globalThis, "fetch");
        await expect(path.run()).rejects.toMatchObject({
          code: "BYOK_CREDENTIAL_INVALID",
        });
        expect(state.select).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    test(`${path.name} preserves a decryption failure without trying another credential`, async () => {
      const failure = new Error("Secret envelope cannot be opened");
      state.decrypt.mockRejectedValue(failure);
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(path.run()).rejects.toBe(failure);
      expect(state.decrypt).toHaveBeenCalledOnce();
      expect(state.select).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    test(`${path.name} checks workspace authorization before looking up a credential`, async () => {
      state.requireWorkspace.mockRejectedValue(
        new ContentError(403, "FORBIDDEN", "Forbidden"),
      );
      await expect(path.run()).rejects.toMatchObject({ statusCode: 403 });
      expect(path.lookup).not.toHaveBeenCalled();
      expect(state.decrypt).not.toHaveBeenCalled();
    });
  }
});
