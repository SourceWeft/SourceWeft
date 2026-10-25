import assert from "node:assert/strict";
import { test } from "vitest";
import {
  mcpInvalidAttemptUrl,
  mcpReturnUrl,
  parseMcpReturnTo,
} from "./oauth-return-to";

const WEB = "https://app.sourceweft.test";

test("accepts only the enumerated internal routes", () => {
  for (const value of [
    "/dashboard/mcp",
    "/dashboard/mcp/io.github.o%2Fexample",
    "/dashboard/mcp/plain-server",
  ]) {
    assert.equal(parseMcpReturnTo(value), value, value);
  }
});

test("rejects absolute, protocol-relative, backslash, encoded and unlisted destinations", () => {
  for (const value of [
    undefined,
    null,
    42,
    "",
    "dashboard/mcp",
    "https://evil.example/dashboard/mcp",
    "http://localhost/dashboard/mcp",
    "//evil.example/dashboard/mcp",
    "///evil.example",
    "/\\evil.example",
    "/dashboard\\mcp",
    "/dashboard/mcp\\..\\x",
    "/dashboard/mcp?next=https://evil.example",
    "/dashboard/mcp#frag",
    "/dashboard/mcp/..",
    "/dashboard/mcp/%2e%2e",
    "/dashboard/mcp/%2F%2Fevil.example",
    "/dashboard/mcp/%252F",
    "/dashboard/mcp/a%5Cb",
    "/dashboard/mcp/a%0d%0aLocation:x",
    "/dashboard/mcp/a b",
    "/dashboard/mcp/\u0000",
    "/dashboard/mcp/",
    "/dashboard/mcp/a/b",
    // Routes nothing starts a connection from.
    "/dashboard/chat",
    "/dashboard/chat/thread_1-a",
    "/mcp/io.github.o%2Fexample",
    "/zh-CN/mcp/io.github.o%2Fexample",
    // The characters encodeURIComponent leaves alone are not part of an identifier.
    "/dashboard/mcp/a(b)",
    "/dashboard/billing",
    "/api/auth/sign-out",
    "/v1/mcp/oauth/callback",
    "/fr/mcp/x",
    "/mcp",
    "javascript:alert(1)",
    `/dashboard/mcp/${"a".repeat(600)}`,
  ]) {
    assert.equal(parseMcpReturnTo(value), null, String(value));
  }
});

test("redirects are built on the web base origin with the attempt's own parameters", () => {
  assert.equal(
    mcpReturnUrl(WEB, "/dashboard/mcp/io.github.o%2Fexample", {
      mcpOAuth: "connected",
      mcpRef: "abc",
    }),
    `${WEB}/dashboard/mcp/io.github.o%2Fexample?mcpOAuth=connected&mcpRef=abc`,
  );
  // No destination (or an invalid stored one) falls back to the market page.
  assert.equal(
    mcpReturnUrl(WEB, null, { mcpOAuth: "error" }),
    `${WEB}/dashboard/mcp?mcpOAuth=error`,
  );
  assert.equal(
    mcpReturnUrl(WEB, "https://evil.example/x", { mcpOAuth: "error" }),
    `${WEB}/dashboard/mcp?mcpOAuth=error`,
  );
});

test("the page for an unknown, expired or replayed attempt is fixed", () => {
  assert.equal(mcpInvalidAttemptUrl(WEB), `${WEB}/dashboard/mcp?mcpOAuth=invalid`);
});
