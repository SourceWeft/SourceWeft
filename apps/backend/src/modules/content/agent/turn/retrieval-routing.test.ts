import assert from "node:assert/strict";
import test from "node:test";
import { shouldPreRetrieveForTurn } from "./retrieval-routing";

test("shouldPreRetrieveForTurn routes targeted extraction questions to retrieval", () => {
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "注册的域名是？",
      sourceIds: ["source-1"],
    }),
    true,
  );
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "What is the invoice number?",
      sourceIds: ["source-1"],
    }),
    true,
  );
});

test("shouldPreRetrieveForTurn does not pre-retrieve without selected sources", () => {
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "注册的域名是？",
      sourceIds: [],
    }),
    false,
  );
});

test("shouldPreRetrieveForTurn leaves source-wide tasks to filesystem coverage", () => {
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "总结这两个文件",
      sourceIds: ["source-1", "source-2"],
    }),
    false,
  );
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "Compare all key points in these files",
      sourceIds: ["source-1", "source-2"],
    }),
    false,
  );
});

test("shouldPreRetrieveForTurn leaves explicit lexical searches to grep", () => {
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "查找 sinosepmem.com 出现在哪",
      sourceIds: ["source-1"],
    }),
    false,
  );
  assert.equal(
    shouldPreRetrieveForTurn({
      messageContent: "Search for exact string sinosepmem.com",
      sourceIds: ["source-1"],
    }),
    false,
  );
});
