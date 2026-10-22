// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceMcpInstallSchema } from "@sourceweft/contracts";
import { HttpClientError, type WorkspaceMcpInstall } from "@sourceweft/sdk";

import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const api = vi.hoisted(() => ({
  authorizeWorkspaceMcpOAuth: vi.fn(),
  upsertWorkspaceMcpCredentials: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { CredentialsDialog } from "./mcp-credentials-dialog";

type Auth = Record<string, unknown>;

function install(
  authType: WorkspaceMcpInstall["authType"],
  auth: Auth,
  patch: Partial<WorkspaceMcpInstall> = {},
): WorkspaceMcpInstall {
  return {
    ...workspaceMcpInstallSchema.parse({
      authType,
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: null,
      credentialStatus: "required",
      desktopOnly: false,
      enabled: true,
      endpointUrl: "https://mcp.example/mcp",
      id: "install-1",
      lastError: null,
      lastTestedAt: null,
      manifestJson: {
        auth: { type: authType, ...auth },
        endpointUrl: "https://mcp.example/mcp",
        identifier: "io.github.o/example",
        name: "Example",
        schemaVersion: 1,
        summary: "An example server.",
        transport: "streamable_http",
        version: "1.0.0",
      },
      marketIdentifier: "io.github.o/example",
      marketVersion: "1.0.0",
      name: "Example",
      official: false,
      signature: null,
      signingKeyId: null,
      source: "market",
      status: "active",
      summary: "An example server.",
      teamId: "team-1",
      transport: "streamable_http",
      updatedAt: "2026-10-01T00:00:00.000Z",
      verified: false,
      webExecutable: true,
      workspaceId: "ws-1",
    }),
    ...patch,
  };
}

// Arcmira-like: OAuth sign-in, or the account key as a bearer token.
const DUAL_AUTH: Auth = {
  required: true,
  headerName: "Authorization",
  allowedHeaderNames: ["Authorization"],
  posture: "required",
  methods: [
    { type: "oauth" },
    {
      type: "header",
      name: "Authorization",
      scheme: "bearer",
      description: "Your Arcmira account key.",
    },
  ],
};

// Exa-like: open, with an optional key header.
const OPTIONAL_AUTH: Auth = {
  required: false,
  posture: "optional",
  methods: [{ type: "header", name: "x-api-key" }],
};

const onClose = vi.fn();
const onSaved = vi.fn();

async function open(target: WorkspaceMcpInstall) {
  await mountWithIntl(
    <CredentialsDialog
      install={target}
      onClose={onClose}
      onSaved={onSaved}
      open
      workspaceId="ws-1"
    />,
  );
}

const dialog = () =>
  document.body.querySelector<HTMLElement>('[role="dialog"]')!;
const radios = () =>
  [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].map(
    (radio) => ({
      checked: radio.getAttribute("aria-checked") === "true",
      label: radio.closest("label")?.textContent?.trim(),
      radio,
    }),
  );
const radio = (label: string) =>
  radios().find((option) => option.label === label)!.radio;
const keyField = () =>
  dialog().querySelector<HTMLInputElement>("#mcp-header-key");
const text = () => dialog().textContent ?? "";

beforeEach(() => {
  api.upsertWorkspaceMcpCredentials.mockImplementation(
    async (_workspaceId: string, installId: string) => ({
      install: { id: installId, connectedVia: "header" },
    }),
  );
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

describe("credentials dialog for a server that takes OAuth or an API key", () => {
  it("offers both methods, OAuth first when the member is not connected", async () => {
    await open(install("oauth", DUAL_AUTH));
    expect(radios().map(({ checked, label }) => ({ checked, label }))).toEqual([
      { checked: true, label: "Sign in with OAuth" },
      { checked: false, label: "Use an API key" },
    ]);
    expect(text()).toContain("OAuth or API key");
    expect(button("Connect", dialog())).toBeDefined();
    expect(keyField()).toBeNull();
    // Nothing to replace yet.
    expect(text()).not.toContain("Switching replaces");
  });

  it("saves the key as a bearer token, with Bearer as a fixed prefix", async () => {
    await open(install("oauth", DUAL_AUTH));
    await click(radio("Use an API key"));
    const field = keyField()!;
    expect(field.type).toBe("password");
    expect(
      dialog().querySelector('label[for="mcp-header-key"]')?.textContent,
    ).toBe("Authorization");
    expect(field.closest('[data-slot="input-group"]')?.textContent).toContain(
      "Bearer",
    );
    expect(text()).toContain("Your Arcmira account key.");

    // A pasted "Bearer " is not sent twice.
    typeInto(field, "  Bearer sk-live-123 ");
    await click(button("Save", dialog()));
    await flush(2);
    expect(api.upsertWorkspaceMcpCredentials).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      { authType: "bearer", bearerToken: "sk-live-123" },
    );
    expect(onSaved).toHaveBeenCalledWith({
      id: "install-1",
      connectedVia: "header",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("validates an empty key inline without calling the server", async () => {
    await open(install("oauth", DUAL_AUTH));
    await click(radio("Use an API key"));
    await click(button("Save", dialog()));
    expect(api.upsertWorkspaceMcpCredentials).not.toHaveBeenCalled();
    expect(text()).toContain("Enter an API key before saving.");
    expect(keyField()!.getAttribute("aria-invalid")).toBe("true");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("opens on the member's current method and warns before switching", async () => {
    await open(
      install("oauth", DUAL_AUTH, {
        connectedVia: "header",
        credentialStatus: "configured",
      }),
    );
    expect(radios().find(({ checked }) => checked)?.label).toBe(
      "Use an API key",
    );
    expect(text()).toContain("Connected with an API key");
    expect(text()).not.toContain("Switching replaces your current connection.");

    await click(radio("Sign in with OAuth"));
    expect(text()).toContain("Switching replaces your current connection.");
    expect(button("Connect", dialog())).toBeDefined();
  });

  it("shows an OAuth connection and warns when switching to a key", async () => {
    await open(
      install("oauth", DUAL_AUTH, {
        connectedVia: "oauth",
        credentialStatus: "configured",
      }),
    );
    expect(radios().find(({ checked }) => checked)?.label).toBe(
      "Sign in with OAuth",
    );
    expect(text()).toContain("Connected with OAuth");
    await click(radio("Use an API key"));
    expect(text()).toContain("Switching replaces your current connection.");
  });

  it("says readably when the server refuses the method", async () => {
    api.upsertWorkspaceMcpCredentials.mockRejectedValue(
      new HttpClientError({
        code: "MCP_CREDENTIAL_METHOD_NOT_ALLOWED",
        message: "Credential method not allowed",
        status: 400,
        statusText: "Bad Request",
      }),
    );
    await open(install("oauth", DUAL_AUTH));
    await click(radio("Use an API key"));
    typeInto(keyField()!, "sk-live-123");
    await click(button("Save", dialog()));
    await flush(2);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      "This server doesn't accept that connection method.",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("credentials dialog for a key header", () => {
  it("sends a non-bearer key in the method's header, not one the member types", async () => {
    await open(
      install("oauth", {
        required: true,
        headerName: "X-Api-Key",
        allowedHeaderNames: ["X-Api-Key"],
        methods: [{ type: "oauth" }, { type: "header", name: "X-Api-Key" }],
      }),
    );
    await click(radio("Use an API key"));
    expect(dialog().querySelector('[data-slot="input-group"]')).toBeNull();
    expect(
      dialog().querySelector('label[for="mcp-header-key"]')?.textContent,
    ).toBe("X-Api-Key");
    // No header-name field to type into.
    expect(dialog().querySelector("#mcp-api-header")).toBeNull();
    typeInto(keyField()!, " key-1 ");
    await click(button("Save", dialog()));
    await flush(2);
    expect(api.upsertWorkspaceMcpCredentials).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      {
        authType: "api_key_header",
        apiKeyHeaderName: "X-Api-Key",
        apiKey: "key-1",
      },
    );
  });

  it("offers an open server's key as optional, with Save", async () => {
    await open(
      install("none", OPTIONAL_AUTH, { credentialStatus: "not_required" }),
    );
    expect(radios()).toEqual([]);
    expect(text()).toContain("Not required · optional API key");
    expect(text()).toContain(
      "This MCP server works without a credential. Add an API key if you have one.",
    );
    expect(text()).not.toContain(
      "This MCP server does not require credentials.",
    );
    expect(
      dialog().querySelector('label[for="mcp-header-key"]')?.textContent,
    ).toBe("x-api-keyOptional");
    typeInto(keyField()!, "exa-key");
    await click(button("Save", dialog()));
    await flush(2);
    expect(api.upsertWorkspaceMcpCredentials).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      {
        authType: "api_key_header",
        apiKeyHeaderName: "x-api-key",
        apiKey: "exa-key",
      },
    );
  });
});

describe("credentials dialog for installs without methods", () => {
  it("keeps the OAuth connect panel without a choice", async () => {
    await open(install("oauth", { required: true }, { connectedVia: "oauth" }));
    expect(radios()).toEqual([]);
    expect(text()).toContain("This MCP server uses OAuth.");
    expect(button("Connect", dialog())).toBeDefined();
    expect(button("Close", dialog())).toBeDefined();
    expect(button("Save", dialog())).toBeUndefined();
    expect(text()).not.toContain("Connected with");
  });

  it("keeps the header-name and key form for an API key header", async () => {
    await open(
      install("api_key_header", { required: true, headerName: "X-Api-Key" }),
    );
    expect(radios()).toEqual([]);
    expect(keyField()).toBeNull();
    const headerName =
      dialog().querySelector<HTMLInputElement>("#mcp-api-header")!;
    expect(headerName.value).toBe("X-Api-Key");
    typeInto(dialog().querySelector<HTMLInputElement>("#mcp-api-key")!, "k");
    await click(button("Save", dialog()));
    await flush(2);
    expect(api.upsertWorkspaceMcpCredentials).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      {
        authType: "api_key_header",
        apiKeyHeaderName: "X-Api-Key",
        apiKey: "k",
      },
    );
  });

  it("keeps the no-credential note for an open server", async () => {
    await open(install("none", { required: false }));
    expect(text()).toContain("This MCP server does not require credentials.");
    expect(keyField()).toBeNull();
  });
});
