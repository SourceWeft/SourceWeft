import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_SYSTEM_PROMPT } from "./prompts";

test("base chat system prompt does not mention optional web tools", () => {
  assert.equal(CHAT_SYSTEM_PROMPT.includes("web_search"), false);
  assert.equal(CHAT_SYSTEM_PROMPT.includes("web_fetch"), false);
});
