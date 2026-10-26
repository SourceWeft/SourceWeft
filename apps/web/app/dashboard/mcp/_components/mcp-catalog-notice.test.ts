import { describe, expect, it } from "vitest";
import { workspaceMcpInstallSchema } from "@sourceweft/contracts";
import { catalogNoticeApplies } from "./mcp-catalog-notice";

function install(patch: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) {
  return workspaceMcpInstallSchema.parse({
    authType: "oauth",
    createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: null,
    credentialStatus: "required",
    desktopOnly: false,
    enabled: true,
    endpointUrl: "https://mcp.example.com/mcp",
    id: "install-1",
    lastError: null,
    lastTestedAt: null,
    manifestJson: {
      auth: { type: "oauth", required: true, ...auth },
      endpointUrl: "https://mcp.example.com/mcp",
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
    ...patch,
  });
}
const none = { declaredKeyMethod: false, apiKeyHeaderName: "" };

describe("catalogNoticeApplies", () => {
  it("applies to a catalog install at the listing's own address", () => {
    expect(catalogNoticeApplies(install(), none)).toBe(true);
    expect(catalogNoticeApplies(install({ endpointUrl: "https://MCP.example.com./mcp" }), none)).toBe(true);
  });

  it("does not apply without an install, off the catalog, or at an edited address", () => {
    expect(catalogNoticeApplies(null, none)).toBe(false);
    expect(catalogNoticeApplies(install({ source: "custom" }), none)).toBe(false);
    expect(catalogNoticeApplies(install({ endpointUrl: "https://proxy.example/mcp" }), none)).toBe(false);
    expect(catalogNoticeApplies(install({ endpointUrl: "https://mcp.example.com/mcp?x=1" }), none)).toBe(false);
    expect(catalogNoticeApplies(install({ endpointUrl: null }), none)).toBe(false);
  });

  it("does not apply to an account-specific gateway", () => {
    const endpointUrl = "https://mcp.zapier.com/api/mcp/mcp";
    const gateway = install({ endpointUrl });
    gateway.manifestJson.endpointUrl = endpointUrl;
    expect(catalogNoticeApplies(gateway, none)).toBe(false);
  });

  it("does not apply to custom headers, but a declared key method does", () => {
    const custom = install({ authType: "custom_headers" });
    expect(catalogNoticeApplies(custom, none)).toBe(false);
    expect(catalogNoticeApplies(custom, { ...none, declaredKeyMethod: true })).toBe(true);
  });

  it("applies to a key only under the listing's declared header", () => {
    const key = install({ authType: "api_key_header" }, { type: "api_key_header", headerName: "X-Api-Key" });
    expect(catalogNoticeApplies(key, { ...none, apiKeyHeaderName: "x-api-key" })).toBe(true);
    expect(catalogNoticeApplies(key, { ...none, apiKeyHeaderName: "X-Mcp-Toolsets" })).toBe(false);
    expect(catalogNoticeApplies(key, none)).toBe(false);
  });
});
