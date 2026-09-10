import { describe, expect, it } from "vitest";
import {
  HubViewCache,
  hubContextKey,
  validateHubCommand,
  type HubCommand,
  type HubSnapshot,
} from "./hub-protocol";

const snapshot = {
  sessionId: "session",
  contextKey: hubContextKey("user", "workspace", "A"),
  revision: 7,
  phase: "active",
} as HubSnapshot;
const command: HubCommand = {
  id: "command",
  sessionId: "session",
  contextKey: snapshot.contextKey,
  revision: 7,
  action: { type: "sources", ids: ["source"] },
};

describe("Hub command isolation", () => {
  it("accepts only the current context and revision", () => {
    expect(validateHubCommand(command, snapshot)).toBeNull();
    for (const contextKey of [
      hubContextKey("user", "workspace", "B"),
      hubContextKey("other", "workspace", "A"),
      hubContextKey("user", "other", "A"),
    ]) {
      expect(validateHubCommand(command, { ...snapshot, contextKey })).toMatch(
        /conversation changed/,
      );
    }
    expect(
      validateHubCommand(command, { ...snapshot, sessionId: "restarted" }),
    ).not.toBeNull();
    expect(validateHubCommand(command, { ...snapshot, revision: 8 })).toMatch(
      /state changed/,
    );
  });
  it("blocks selection during navigation or away from chat but permits return", () => {
    for (const phase of ["transition", "away"] as const) {
      expect(
        validateHubCommand(command, { ...snapshot, phase }),
      ).not.toBeNull();
      expect(
        validateHubCommand(
          { ...command, action: { type: "return" } },
          { ...snapshot, phase },
        ),
      ).toBeNull();
    }
  });
  it("rejects invalid actions and selection payloads", () => {
    expect(
      validateHubCommand(
        {
          ...command,
          action: { type: "sources", ids: [2] },
        } as unknown as HubCommand,
        snapshot,
      ),
    ).not.toBeNull();
    expect(
      validateHubCommand(
        {
          ...command,
          action: { type: "eval", code: "x" },
        } as unknown as HubCommand,
        snapshot,
      ),
    ).not.toBeNull();
  });
});

it("keeps browsing state scoped and bounded, and clears it on logout", () => {
  const cache = new HubViewCache();
  for (let i = 0; i < 51; i++)
    cache.set(`thread-${i}`, {
      tab: "Sources",
      queries: { Sources: String(i) },
    });
  expect(cache.get("thread-0")).toBeUndefined();
  expect(cache.get("thread-1")?.queries?.Sources).toBe("1");
  cache.set("thread-1", { tab: "Artifacts" });
  cache.set("thread-51", { tab: "MCP" });
  expect(cache.get("thread-2")).toBeUndefined();
  expect(cache.get("thread-1")?.tab).toBe("Artifacts");
  cache.clear();
  expect(cache.get("thread-1")).toBeUndefined();
});
