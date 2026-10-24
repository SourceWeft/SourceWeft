import { describe, expect, it } from "vitest";

import { mcpToolsStatus } from "./mcp-tools-status";

const remote = {
  requiresAuth: false,
  toolsCount: 0,
  transport: "streamable_http" as const,
};
const stdio = { ...remote, transport: "stdio" as const };

describe("mcpToolsStatus", () => {
  it("lists a count, and says when the listing is capped", () => {
    expect(mcpToolsStatus({ item: { ...remote, toolsCount: 3 } })).toEqual({
      count: 3,
      kind: "listed",
    });
    expect(mcpToolsStatus({ item: remote, count: 200 })).toEqual({
      count: 200,
      kind: "partial",
    });
  });

  it("never says zero for a remote that asks for credentials", () => {
    for (const result of ["credential", "oauth"]) {
      expect(
        mcpToolsStatus({
          item: remote,
          provenanceJson: { authProbe: { result } },
        }),
      ).toEqual({ kind: "authRequired" });
    }
    // A list answer has no provenance: the summary's flag stands in.
    expect(mcpToolsStatus({ item: { ...remote, requiresAuth: true } })).toEqual(
      { kind: "authRequired" },
    );
  });

  it("separates a successfully empty remote from one not read yet", () => {
    expect(
      mcpToolsStatus({
        item: remote,
        provenanceJson: {
          authProbe: { result: "open" },
          toolsListing: { listedAt: "2026-10-20T00:00:00.000Z", toolsCount: 0 },
        },
      }),
    ).toEqual({ kind: "empty" });
    expect(
      mcpToolsStatus({
        item: remote,
        provenanceJson: { authProbe: { result: "open" } },
      }),
    ).toEqual({ kind: "unindexed" });
    expect(mcpToolsStatus({ item: remote })).toEqual({ kind: "unindexed" });
  });

  it("tells a stdio package that failed from one never tried", () => {
    expect(
      mcpToolsStatus({
        item: {
          ...stdio,
          toolsValidation: {
            at: "2026-10-20T00:00:00.000Z",
            reason: "start",
            status: "failed",
          },
        },
      }),
    ).toEqual({ kind: "failed", reason: "start" });
    expect(mcpToolsStatus({ item: stdio })).toEqual({ kind: "notValidated" });
    expect(
      mcpToolsStatus({
        item: stdio,
        provenanceJson: { validatedAt: "2026-10-20T00:00:00.000Z" },
      }),
    ).toEqual({ kind: "empty" });
  });

  it("reads the failure from the versions when the summary predates it", () => {
    expect(
      mcpToolsStatus({
        item: stdio,
        versions: [
          {
            provenanceJson: {
              validation: {
                at: "2026-10-20T00:00:00.000Z",
                reason: "install",
                status: "failed",
              },
            },
          },
        ],
      }),
    ).toEqual({ kind: "failed", reason: "install" });
  });
});
