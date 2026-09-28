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

test("the billing top-up glossary entries are scoped to whole phrases, not a bare '充值' substring", () => {
  // A global "充值": "儲值" entry would corrupt any other Simplified word that
  // merely contains "充值" as a substring, since the glossary applies naive
  // `String.split/join` to the post-OpenCC text. "积分充值"/"页面充值" (credit/page
  // top-up) are the only real occurrences in our catalogs, so the glossary
  // maps those two whole phrases instead of the bare substring.
  assert.equal(toTaiwanTraditional("设置填充值为 0"), "設定填充值為 0");
  assert.equal(toTaiwanTraditional("补充值"), "補充值");
  assert.equal(toTaiwanTraditional("扩充值域"), "擴充值域");

  // The real billing phrases still get the Taiwan top-up wording. Note
  // "已购买积分充值包"/"已购买页面充值包" contain both a 4-char phrase entry
  // ("積分充值"/"頁面充值") and the 3-char "充值包" entry as overlapping
  // substrings (sharing "充值") — the longer entry is applied first (entries
  // are sorted longest-first), consuming "充值" before "充值包" gets a turn,
  // so there is no double-substitution.
  assert.equal(toTaiwanTraditional("已购买积分充值包"), "已購買點數儲值包");
  assert.equal(toTaiwanTraditional("已购买页面充值包"), "已購買頁面儲值包");
  assert.equal(toTaiwanTraditional("积分充值已退款"), "點數儲值已退款");
  assert.equal(toTaiwanTraditional("页面充值已退款"), "頁面儲值已退款");
  assert.equal(toTaiwanTraditional("积分充值已被拒付"), "點數儲值已被拒付");
  assert.equal(toTaiwanTraditional("页面充值已被拒付"), "頁面儲值已被拒付");
  // The top-up dialog's description ("选择充值包…") has no 积分/页面 prefix,
  // so it only matches the bare "充值包" entry.
  assert.equal(
    toTaiwanTraditional("选择充值包并在付款前核对总额。"),
    "選擇儲值包並在付款前核對總額。",
  );
});
