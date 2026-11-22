import assert from "node:assert/strict";
import { test } from "vitest";
import { exportThreadRequestSchema } from "@sourceweft/contracts";
import { contentDispositionAttachment, exportFileBaseName } from "./file-name";

test("reserved file-name characters become dashes", () => {
  assert.equal(exportFileBaseName("Q3: budget/plan?"), "Q3- budget-plan-");
});

test("CJK is kept and whitespace collapses", () => {
  assert.equal(exportFileBaseName("预算  复盘"), "预算 复盘");
});

test("long titles are cut to 80 characters", () => {
  assert.equal(exportFileBaseName("a".repeat(100)).length, 80);
});

test("titles without a letter or digit fall back to chat", () => {
  assert.equal(exportFileBaseName("..."), "chat");
  assert.equal(exportFileBaseName("<>"), "chat");
  assert.equal(exportFileBaseName("   "), "chat");
});

test("Content-Disposition carries an ASCII fallback and a UTF-8 name", () => {
  assert.equal(
    contentDispositionAttachment("预算.md"),
    "attachment; filename=\"__.md\"; filename*=UTF-8''%E9%A2%84%E7%AE%97.md",
  );
});

test("export request defaults to en and UTC", () => {
  assert.deepEqual(exportThreadRequestSchema.parse({}), {
    locale: "en",
    timeZone: "UTC",
  });
});

test("export request rejects an unknown time zone", () => {
  assert.equal(
    exportThreadRequestSchema.safeParse({ timeZone: "Mars/Base" }).success,
    false,
  );
});
