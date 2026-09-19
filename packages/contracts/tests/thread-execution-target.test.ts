import assert from "node:assert/strict";
import { test } from "node:test";
import { threadExecutionTargetSchema } from "../src/threads";
const deviceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const grant = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
test("local targets accept either directory grant format without ambiguity", () => {
  for (const value of [
    { kind: "cloud" },
    { kind: "local", deviceId },
    { kind: "local", deviceId, folderId: grant },
    { kind: "local", deviceId, directoryGrantId: grant },
  ])
    assert.equal(threadExecutionTargetSchema.safeParse(value).success, true);
  for (const value of [
    { kind: "cloud", folderId: grant },
    { kind: "local", deviceId, folderId: grant, directoryGrantId: grant },
    { kind: "local", deviceId, directoryGrantId: "invalid" },
    { kind: "local", deviceId, path: "/Users/test" },
  ])
    assert.equal(threadExecutionTargetSchema.safeParse(value).success, false);
});
