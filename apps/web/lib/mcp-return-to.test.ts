import { describe, expect, it } from "vitest";
import { acceptedMcpReturnTo, chatThreadOf } from "./mcp-return-to";

describe("acceptedMcpReturnTo", () => {
  it.each([
    "/dashboard/mcp",
    "/dashboard/mcp/io.github.o%2Fexample",
    "/dashboard/mcp/plain-server",
    "/dashboard/chat",
    "/dashboard/chat/thread_123-abc",
    "/mcp/io.github.o%2Fexample",
    "/zh-CN/mcp/io.github.o%2Fexample",
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
