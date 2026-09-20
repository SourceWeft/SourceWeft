import { describe, expect, it } from "vitest";
import {
  buildEmbedThreadPath,
  isEmbedMode,
  joinPathAndQuery,
  readAgentParam,
  withAgentParam,
} from "./thread-embed-params";

describe("thread embed params", () => {
  it("recognises embed mode from a query string or params object", () => {
    expect(isEmbedMode("?embed=1")).toBe(true);
    expect(isEmbedMode("embed=true")).toBe(true);
    expect(isEmbedMode(new URLSearchParams("embed=0"))).toBe(false);
    expect(isEmbedMode("")).toBe(false);
    expect(isEmbedMode(null)).toBe(false);
  });

  it("reads the agent parameter and ignores blanks", () => {
    expect(readAgentParam("?agent=thread_2")).toBe("thread_2");
    expect(readAgentParam("agent=%20")).toBe(null);
    expect(readAgentParam(undefined)).toBe(null);
  });

  it("sets and clears the agent parameter while keeping the others", () => {
    expect(withAgentParam("?embed=1", "thread_2")).toBe(
      "embed=1&agent=thread_2",
    );
    expect(withAgentParam("agent=thread_1&x=y", "thread_2")).toBe(
      "agent=thread_2&x=y",
    );
    expect(withAgentParam(new URLSearchParams("agent=thread_1"), null)).toBe(
      "",
    );
    expect(withAgentParam(null, null)).toBe("");
  });

  it("builds the embedded route and joins paths without a dangling ?", () => {
    expect(buildEmbedThreadPath("thread 2")).toBe(
      "/dashboard/chat/thread%202?embed=1",
    );
    expect(joinPathAndQuery("/dashboard/chat/t1", "")).toBe(
      "/dashboard/chat/t1",
    );
    expect(joinPathAndQuery("/dashboard/chat/t1", "agent=t2")).toBe(
      "/dashboard/chat/t1?agent=t2",
    );
  });
});
