import { describe, expect, it } from "vitest";
import {
  acceptedMcpOrigin,
  acceptedMcpReturnTo,
  chatThreadOf,
  readMcpOrigin,
  rememberMcpOrigin,
  syncMcpOrigin,
} from "./mcp-return-to";

describe("acceptedMcpReturnTo", () => {
  it.each([
    "/dashboard/mcp",
    "/dashboard/mcp/io.github.o%2Fexample",
    "/dashboard/mcp/plain-server",
  ])("accepts %s", (value) => {
    expect(acceptedMcpReturnTo(value)).toBe(value);
  });

  it.each([
    "",
    null,
    "https://evil.example/dashboard/mcp",
    "//evil.example/dashboard/mcp",
    "/\\evil.example",
    "/dashboard/mcp\\..\\x",
    "/dashboard/mcp?next=/x",
    "/dashboard/mcp#x",
    "/dashboard/mcp/..",
    "/dashboard/mcp/%2e%2e",
    "/dashboard/mcp/%2F%2Fevil.example",
    "/dashboard/mcp/%252F",
    "/dashboard/mcp/a%5Cb",
    "/dashboard/chat",
    "/mcp/io.github.o%2Fexample",
    "/dashboard/mcp/a(b)",
    "/dashboard/chat/a/b",
    "/dashboard/billing",
    "/fr/mcp/x",
    "/dashboard/mcp/",
    "javascript:alert(1)",
  ])("rejects %s", (value) => {
    expect(acceptedMcpReturnTo(value)).toBeNull();
  });
});

describe("chatThreadOf", () => {
  it("names the thread only for a chat thread page", () => {
    expect(chatThreadOf("/dashboard/chat/abc")).toBe("abc");
    expect(chatThreadOf("/dashboard/chat")).toBeNull();
    expect(chatThreadOf("/mcp/x")).toBeNull();
    expect(chatThreadOf(null)).toBeNull();
  });
});

describe("acceptedMcpOrigin", () => {
  it.each([
    "/dashboard/mcp",
    "/dashboard/mcp/io.github.o%2Fexample",
    "/dashboard/chat",
    "/dashboard/chat/thread_123-abc",
    "/mcp/io.github.o%2Fexample",
    "/zh-CN/mcp/io.github.o%2Fexample",
  ])("accepts %s", (value) => {
    expect(acceptedMcpOrigin(value)).toBe(value);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/dashboard/chat/a/b",
    "/fr/mcp/x",
    "/mcp/x/",
    "/dashboard/billing",
    "/dashboard/chat?x=1",
  ])("rejects %s", (value) => {
    expect(acceptedMcpOrigin(value)).toBeNull();
  });
});

describe("syncMcpOrigin", () => {
  it("remembers a valid origin, forgets a stale one on a plain load, keeps it on the return from the provider", () => {
    // jsdom-free: a minimal sessionStorage stand-in.
    const store = new Map<string, string>();
    const original = globalThis.window;
    globalThis.window = {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    } as unknown as Window & typeof globalThis;
    try {
      syncMcpOrigin(new URLSearchParams("returnTo=/dashboard/chat/t1"));
      expect(readMcpOrigin()).toBe("/dashboard/chat/t1");
      // Back from the provider: the return flags are present, keep it.
      syncMcpOrigin(new URLSearchParams("mcpOAuth=connected&mcpRef=abc"));
      expect(readMcpOrigin()).toBe("/dashboard/chat/t1");
      // A plain load of the page is a different flow: forget it.
      syncMcpOrigin(new URLSearchParams(""));
      expect(readMcpOrigin()).toBeNull();
      // An origin the allowlist refuses is never stored.
      syncMcpOrigin(new URLSearchParams("returnTo=https://evil.example"));
      expect(readMcpOrigin()).toBeNull();
      rememberMcpOrigin(null);
      expect(readMcpOrigin()).toBeNull();
    } finally {
      globalThis.window = original;
    }
  });
});
