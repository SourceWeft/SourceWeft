import { describe, expect, it } from "vitest";
import { mcpAuthExplanation, mcpAuthMethod } from "./mcp-auth-method";

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

  // Issue #337: an open server that accepts a key header (Exa-like).
  it("names an optional API key for an optional posture with a key header", () => {
    const exa = auth({
      posture: "optional",
      methods: [{ type: "header", name: "x-api-key" }],
    });
    expect(mcpAuthMethod(exa)).toBe("optionalApiKey");
    // Even if a required flag disagrees, the posture names it optional.
    expect(
      mcpAuthMethod({ ...exa, type: "api_key_header", required: true }),
    ).toBe("optionalApiKey");
  });

  it("keeps the earlier labels without a key header or an optional posture", () => {
    // An optional posture with no header method to send is still not required.
    expect(
      mcpAuthMethod(
        auth({ posture: "optional", methods: [{ type: "oauth" }] }),
      ),
    ).toBe("notRequired");
    expect(mcpAuthMethod(auth({ posture: "optional" }))).toBe("notRequired");
    // A required posture leaves the type to decide, as before.
    expect(
      mcpAuthMethod(
        auth({
          type: "oauth",
          required: true,
          headerName: "Authorization",
          posture: "required",
          methods: [
            { type: "oauth" },
            { type: "header", name: "Authorization", scheme: "bearer" },
          ],
        }),
      ),
    ).toBe("oauthOrApiKey");
    expect(mcpAuthMethod(auth({ posture: "none", methods: [] }))).toBe(
      "notRequired",
    );
  });
});

describe("mcpAuthExplanation", () => {
  it("names the header a key is sent in, preferring the declared method", () => {
    expect(
      mcpAuthExplanation(
        auth({
          posture: "optional",
          headerName: "X-Old",
          methods: [{ type: "header", name: "x-api-key" }],
        }),
      ),
    ).toEqual({ key: "optionalApiKey", values: { header: "x-api-key" } });
    expect(
      mcpAuthExplanation(
        auth({ type: "oauth", required: true, headerName: "Authorization" }),
      ),
    ).toEqual({ key: "oauthOrApiKey", values: { header: "Authorization" } });
    // A bearer token always travels in Authorization.
    expect(
      mcpAuthExplanation(auth({ type: "bearer", required: true })),
    ).toEqual({ key: "apiKey", values: { header: "Authorization" } });
  });

  it("falls back to an unnamed header, and needs no header for other labels", () => {
    expect(
      mcpAuthExplanation(auth({ type: "api_key_header", required: true })),
    ).toEqual({ key: "apiKeyAnyHeader", values: {} });
    expect(mcpAuthExplanation(auth({}))).toEqual({
      key: "notRequired",
      values: {},
    });
    expect(mcpAuthExplanation(auth({ type: "oauth", required: true }))).toEqual(
      { key: "oauth", values: {} },
    );
    expect(mcpAuthExplanation(null, true)).toEqual({
      key: "required",
      values: {},
    });
  });
});
