/**
 * The tenancy/billing context round-trips through the header deepagents forwards,
 * and a missing/garbled header decodes to null so the endpoint refuses to run a
 * delegate unscoped (which would settle billing against no one).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeRunContextHeader,
  encodeRunContextHeader,
} from "./run-context-header";
import type { RunContextConfig } from "./types";

const context: RunContextConfig = {
  teamId: "team_1",
  workspaceId: "ws_1",
  userId: "user_1",
  modelAlias: "chat-default",
  providerModel: "deepseek-chat",
  profileAlias: "default",
  gatewayConfigId: "gw_1",
  parentThreadId: "thread_parent",
  sourceIds: ["src_a", "src_b"],
};

test("encode → decode round-trips the full context", () => {
  const decoded = decodeRunContextHeader(encodeRunContextHeader(context));
  assert.deepEqual(decoded, context);
});

test("optional fields are omitted when absent", () => {
  const minimal: RunContextConfig = {
    teamId: "team_1",
    workspaceId: "ws_1",
    userId: "user_1",
    modelAlias: "chat-default",
    providerModel: "deepseek-chat",
    profileAlias: "default",
    gatewayConfigId: "gw_1",
    parentThreadId: "thread_parent",
  };
  const decoded = decodeRunContextHeader(encodeRunContextHeader(minimal));
  assert.deepEqual(decoded, minimal);
  assert.ok(!("sourceIds" in (decoded as object)));
});

test("missing / malformed / under-specified headers decode to null", () => {
  assert.equal(decodeRunContextHeader(undefined), null);
  assert.equal(decodeRunContextHeader(""), null);
  assert.equal(decodeRunContextHeader("not-base64-$$$"), null);
  assert.equal(
    decodeRunContextHeader(Buffer.from("{}", "utf8").toString("base64url")),
    null,
  );
  // Missing a required key (modelAlias).
  assert.equal(
    decodeRunContextHeader(
      Buffer.from(
        JSON.stringify({
          teamId: "t",
          workspaceId: "w",
          userId: "u",
          parentThreadId: "p",
        }),
        "utf8",
      ).toString("base64url"),
    ),
    null,
  );
});
