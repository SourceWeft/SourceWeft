import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import type { useTranslations } from "next-intl";
import { MCP_CLAIM_ERROR_CODES } from "@sourceweft/contracts";

import messages from "../messages/en.json";
import { mcpClaimErrorMessage, mcpClaimHref } from "./mcp-claims";

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardMcpClaim",
}) as unknown as ReturnType<typeof useTranslations>;

describe("mcpClaimHref", () => {
  it("encodes the identifier's slash into the query", () => {
    expect(mcpClaimHref("com.notion/mcp")).toBe(
      "/dashboard/mcp/claim?identifier=com.notion%2Fmcp",
    );
    expect(mcpClaimHref("io.github.o/weather")).toBe(
      "/dashboard/mcp/claim?identifier=io.github.o%2Fweather",
    );
  });
});

describe("mcpClaimErrorMessage", () => {
  it("has a message for every code the routes answer with", () => {
    for (const code of MCP_CLAIM_ERROR_CODES) {
      const message = mcpClaimErrorMessage({ code }, t);
      expect(message).not.toBe(t("errors.fallback"));
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it("tells a domain claimant DNS can take time", () => {
    expect(
      mcpClaimErrorMessage({ code: "MCP_CLAIM_TOKEN_NOT_FOUND" }, t),
    ).toMatch(/DNS/);
  });

  it("falls back for unknown codes, non-errors and injection-shaped codes", () => {
    expect(mcpClaimErrorMessage({ code: "SOMETHING_ELSE" }, t)).toBe(
      "Something went wrong. Try again.",
    );
    expect(mcpClaimErrorMessage(new Error("offline"), t)).toBe(
      "Something went wrong. Try again.",
    );
    expect(mcpClaimErrorMessage(null, t)).toBe(
      "Something went wrong. Try again.",
    );
    expect(mcpClaimErrorMessage({ code: "errors.fallback" }, t)).toBe(
      "Something went wrong. Try again.",
    );
    expect(mcpClaimErrorMessage({ code: "X" }, t, "custom")).toBe("custom");
  });
});
