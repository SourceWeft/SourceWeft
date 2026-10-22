import { describe, expect, it } from "vitest";
import { mcpAuthMethod } from "./mcp-auth-method";

const auth = (
  patch: Partial<Parameters<typeof mcpAuthMethod>[0] & object>,
) => ({
  type: "none" as const,
  required: false,
  allowedHeaderNames: [],
  ...patch,
});

describe("mcpAuthMethod", () => {
  it("is not required when nothing is required", () => {
    expect(mcpAuthMethod(auth({}))).toBe("notRequired");
    // An optional credential is still not required.
    expect(
      mcpAuthMethod(auth({ type: "bearer", headerName: "Authorization" })),
    ).toBe("notRequired");
  });

  it("names OAuth, and OAuth or an API key when a credential header is accepted too", () => {
    expect(mcpAuthMethod(auth({ type: "oauth", required: true }))).toBe(
      "oauth",
    );
    expect(
      mcpAuthMethod(
        auth({
          type: "oauth",
          required: true,
          headerName: "Authorization",
          allowedHeaderNames: ["Authorization"],
        }),
      ),
    ).toBe("oauthOrApiKey");
  });

  it("names an API key for a bearer token or a single key header", () => {
    expect(
      mcpAuthMethod(
        auth({ type: "bearer", required: true, headerName: "Authorization" }),
      ),
    ).toBe("apiKey");
    expect(
      mcpAuthMethod(
        auth({
          type: "api_key_header",
          required: true,
          headerName: "X-Api-Key",
        }),
      ),
    ).toBe("apiKey");
  });

  it("names custom headers only when there are headers to name", () => {
    expect(
      mcpAuthMethod(
        auth({
          type: "custom_headers",
          required: true,
          allowedHeaderNames: ["X-Api-Key", "X-Org"],
        }),
      ),
    ).toBe("customHeaders");
    expect(
      mcpAuthMethod(auth({ type: "custom_headers", required: true })),
    ).toBe("required");
  });

  it("falls back to the catalog item's flag without a manifest", () => {
    expect(mcpAuthMethod(null, true)).toBe("required");
    expect(mcpAuthMethod(undefined)).toBe("notRequired");
  });
});
