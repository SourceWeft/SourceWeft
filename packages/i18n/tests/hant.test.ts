import assert from "node:assert/strict";
import { test } from "node:test";

import { toTaiwanTraditional, zhTwGlossary } from "../src/hant.js";

test("converts Simplified to Taiwan Traditional with Taiwan vocabulary", () => {
  assert.equal(toTaiwanTraditional("默认设置"), "預設設定");
  assert.equal(toTaiwanTraditional("仓库许可证"), "儲存庫授權條款");
});

test("repairs OpenCC's word-splitting slips", () => {
  assert.equal(toTaiwanTraditional("资源文件"), "資源檔案");
  assert.equal(toTaiwanTraditional("开源文件"), "開源檔案");
  assert.equal(toTaiwanTraditional("批准并发布"), "核准並發布");
});

test("leaves placeholders and ICU syntax alone", () => {
  assert.equal(
    toTaiwanTraditional("{count, plural, other {# 个技能}}"),
    "{count, plural, other {# 個技能}}",
  );
});

test("exposes the glossary read-only", () => {
  assert.equal(zhTwGlossary["未找到"], "找不到");
  assert.ok(Object.isFrozen(zhTwGlossary));
});
