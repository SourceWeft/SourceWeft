import { describe, expect, it } from "vitest";
import {
  mcpToolsValidation,
  mcpToolsValidationReasonKey,
} from "./mcp-tools-validation";

const failed = {
  status: "failed" as const,
  reason: "start" as const,
  at: "2026-10-24T10:00:00.000Z",
};

describe("mcpToolsValidation", () => {
  it("is the summary's when the server has no tools", () => {
    expect(
      mcpToolsValidation({ toolsCount: 0, toolsValidation: failed }),
    ).toEqual(failed);
  });

  it("is null once the server has tools, whatever an older validation said", () => {
    expect(
      mcpToolsValidation({ toolsCount: 3, toolsValidation: failed }),
    ).toBeNull();
  });

  it("is null when nothing was tried", () => {
    expect(
      mcpToolsValidation({ toolsCount: 0, toolsValidation: null }),
    ).toBeNull();
    expect(mcpToolsValidation({ toolsCount: 0 })).toBeNull();
  });

  it("falls back to the latest version's provenance for an answer without the field", () => {
    expect(
      mcpToolsValidation({ toolsCount: 0 }, [
        {
          provenanceJson: {
            validation: { ...failed, detail: "server exited with 1" },
          },
        },
        { provenanceJson: { validation: { ...failed, reason: "install" } } },
      ]),
    ).toEqual(failed);
    expect(
      mcpToolsValidation({ toolsCount: 0 }, [
        { provenanceJson: { validation: "no" } },
      ]),
    ).toBeNull();
  });

  it("maps reasons to message keys", () => {
    expect(mcpToolsValidationReasonKey("install")).toBe("install");
    expect(mcpToolsValidationReasonKey("unsupported-package")).toBe(
      "unsupportedPackage",
    );
  });
});
