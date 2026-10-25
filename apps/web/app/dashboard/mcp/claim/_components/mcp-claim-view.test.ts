import { describe, expect, it } from "vitest";
import type { McpClaim, McpClaimOverview } from "@sourceweft/contracts";

import {
  claimPageView,
  normalizeClaimIdentifier,
  ownerOverridesForm,
  ownerOverridesPayload,
  ownerOverridesProblems,
  ownerToolsCliSnippet,
  sortMcpClaims,
  verifiedClaimOf,
} from "./mcp-claim-view";

function claim(patch: Partial<McpClaim>): McpClaim {
  return {
    id: "c",
    identifier: "com.example/server",
    method: "github",
    status: "pending",
    target: "example.com",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    verifiedAt: null,
    revokedAt: null,
    lastError: null,
    ...patch,
  };
}

function overview(patch: Partial<McpClaimOverview>): McpClaimOverview {
  return {
    identifier: "com.example/server",
    name: "Example",
    claimed: false,
    claimedByYou: false,
    blocked: false,
    viewerClaims: [],
    methods: {
      github: { available: false, owner: null, reason: "not_github_entry" },
      domain: { available: true, domain: "example.com" },
    },
    overrides: null,
    ...patch,
  };
}

describe("claim page view", () => {
  it("picks the owner panel, the taken note, or the chooser", () => {
    expect(claimPageView(overview({ claimed: true, claimedByYou: true }))).toEqual(
      { kind: "owner" },
    );
    expect(claimPageView(overview({ claimed: true }))).toEqual({
      kind: "claimedBySomeone",
    });
    expect(claimPageView(overview({}))).toEqual({ kind: "open" });
  });

  it("gives a blocked viewer the notice whatever else is true", () => {
    expect(claimPageView(overview({ blocked: true }))).toEqual({
      kind: "blocked",
    });
    expect(claimPageView(overview({ blocked: true, claimed: true }))).toEqual({
      kind: "blocked",
    });
  });

  it("finds the verified claim and orders the list", () => {
    const verified = claim({ id: "v", status: "verified" });
    const pending = claim({ id: "p", createdAt: "2026-10-05T00:00:00.000Z" });
    const revoked = claim({ id: "r", status: "revoked" });
    expect(verifiedClaimOf(overview({ viewerClaims: [pending, verified] }))).toBe(
      verified,
    );
    expect(verifiedClaimOf(overview({ viewerClaims: [pending] }))).toBeNull();
    expect(sortMcpClaims([revoked, pending, verified]).map((c) => c.id)).toEqual(
      ["v", "p", "r"],
    );
  });

  it("trims the identifier and treats an empty one as missing", () => {
    expect(normalizeClaimIdentifier(" com.notion/mcp ")).toBe("com.notion/mcp");
    expect(normalizeClaimIdentifier("")).toBeNull();
    expect(normalizeClaimIdentifier(null)).toBeNull();
  });
});

describe("owner form", () => {
  it("starts empty from nothing stored and sends null for emptied fields", () => {
    const form = ownerOverridesForm(null);
    expect(form).toEqual({
      iconUrl: "",
      summary: "",
      description: "",
      documentationUrl: "",
      homepageUrl: "",
      repoUrl: "",
      deprecated: false,
    });
    expect(
      ownerOverridesPayload({
        ...form,
        summary: "  Forecasts  ",
        repoUrl: "https://github.com/o/r",
        deprecated: true,
      }),
    ).toEqual({
      iconUrl: null,
      summary: "Forecasts",
      description: null,
      documentationUrl: null,
      homepageUrl: null,
      repoUrl: "https://github.com/o/r",
      deprecated: true,
    });
  });

  it("reads stored values back, null as empty", () => {
    expect(
      ownerOverridesForm({
        iconUrl: null,
        summary: "S",
        deprecated: true,
      }),
    ).toMatchObject({ iconUrl: "", summary: "S", deprecated: true });
  });

  it("flags non-http URLs and over-long text, and nothing else", () => {
    const form = ownerOverridesForm(null);
    expect(ownerOverridesProblems(form)).toEqual([]);
    expect(
      ownerOverridesProblems({
        ...form,
        iconUrl: "ftp://x",
        homepageUrl: "not a url",
        repoUrl: "https://github.com/o/r",
        summary: "x".repeat(301),
      }),
    ).toEqual([
      { field: "iconUrl", kind: "url" },
      { field: "homepageUrl", kind: "url" },
      { field: "summary", kind: "tooLong", max: 300 },
    ]);
  });

  it("writes the CLI commands with the identifier and no credentials", () => {
    const snippet = ownerToolsCliSnippet("com.example/server");
    expect(snippet).toContain("sourceweft mcp inspect --url <endpoint>");
    expect(snippet).toContain(
      "sourceweft mcp submit-tools com.example/server mcp-tools.json --api-key <key>",
    );
  });
});
