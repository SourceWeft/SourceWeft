import { describe, expect, it } from "vitest";
import { staticCredentialUsesOnlyDeclaredHeader } from "./auth-methods";

const install = (auth: Record<string, unknown>, authType = "api_key_header") =>
  ({ authType, manifestJson: { auth } }) as never;

const declared = install({
  type: "api_key_header",
  required: true,
  headerName: "X-Api-Key",
  methods: [
    { type: "oauth" },
    { type: "header", name: "X-Api-Key" },
    { type: "header", name: "Authorization", scheme: "bearer" },
  ],
});

describe("staticCredentialUsesOnlyDeclaredHeader", () => {
  it("accepts a key under a declared header, whatever its case", () => {
    expect(staticCredentialUsesOnlyDeclaredHeader(declared, { authType: "api_key_header", headerName: "x-api-key" })).toBe(true);
    expect(staticCredentialUsesOnlyDeclaredHeader(declared, { authType: "api_key_header", headerName: " X-API-KEY " })).toBe(true);
  });

  it("accepts a bearer token when Authorization is declared", () => {
    expect(staticCredentialUsesOnlyDeclaredHeader(declared, { authType: "bearer" })).toBe(true);
  });

  it("refuses a header the listing does not declare (toolset, read-only, scope headers)", () => {
    for (const headerName of ["X-MCP-Toolsets", "X-MCP-Readonly", "X-Api-Key2", "", null]) {
      expect(staticCredentialUsesOnlyDeclaredHeader(declared, { authType: "api_key_header", headerName })).toBe(false);
    }
  });

  it("refuses custom headers always", () => {
    expect(staticCredentialUsesOnlyDeclaredHeader(declared, { authType: "custom_headers" })).toBe(false);
  });

  it("refuses a bearer token when Authorization is not a declared header", () => {
    const keyOnly = install({
      type: "api_key_header",
      headerName: "X-Api-Key",
      methods: [{ type: "header", name: "X-Api-Key" }],
    });
    expect(staticCredentialUsesOnlyDeclaredHeader(keyOnly, { authType: "bearer" })).toBe(false);
  });

  it("derives the declared header of a manifest without methods from its own type", () => {
    const legacyBearer = install({ type: "bearer", required: true }, "bearer");
    expect(staticCredentialUsesOnlyDeclaredHeader(legacyBearer, { authType: "bearer" })).toBe(true);
    const legacyKey = install({ type: "api_key_header", headerName: "X-Legacy" });
    expect(staticCredentialUsesOnlyDeclaredHeader(legacyKey, { authType: "api_key_header", headerName: "x-legacy" })).toBe(true);
    expect(staticCredentialUsesOnlyDeclaredHeader(legacyKey, { authType: "api_key_header", headerName: "x-other" })).toBe(false);
  });
});
