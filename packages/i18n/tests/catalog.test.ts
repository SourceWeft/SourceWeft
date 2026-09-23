import assert from "node:assert/strict";
import test from "node:test";

import {
  deepMergeMessages,
  flattenKeys,
  getFallbackChain,
  type Messages,
} from "../src/catalog";

test("deepMergeMessages folds a namespace in without mutating inputs", () => {
  const base: Messages = { landing: { hero: "Hi" }, pricing: {} };
  const override: Messages = { pricing: { free: { name: "Free" } } };
  const merged = deepMergeMessages(base, override);
  assert.deepEqual(merged, {
    landing: { hero: "Hi" },
    pricing: { free: { name: "Free" } },
  });
  // Inputs are untouched.
  assert.deepEqual(base.pricing, {});
  assert.equal("free" in (override.pricing as Messages), true);
});

test("deepMergeMessages: a leaf override replaces, nested objects merge", () => {
  const base: Messages = { a: { x: "1", y: "2" }, b: "keep" };
  const merged = deepMergeMessages(base, { a: { y: "9", z: "3" } });
  assert.deepEqual(merged, { a: { x: "1", y: "9", z: "3" }, b: "keep" });
});

test("getFallbackChain backstops non-default locales with English", () => {
  assert.deepEqual(getFallbackChain("en"), ["en"]);
  assert.deepEqual(getFallbackChain("zh-CN"), ["zh-CN", "en"]);
  assert.deepEqual(getFallbackChain("zh-TW"), ["zh-TW", "en"]);
});

test("flattenKeys yields sorted dotted paths for cross-locale key comparison", () => {
  const messages: Messages = {
    landing: { hero: { headline: "x", sub: "y" } },
    common: { ok: "z" },
  };
  assert.deepEqual(flattenKeys(messages), [
    "common.ok",
    "landing.hero.headline",
    "landing.hero.sub",
  ]);
});

test("partial, empty or malformed translations preserve English leaves and arrays", () => {
  const en = {
    title: "Title",
    section: { value: "Value" },
    list: ["One", "Two"],
  };
  assert.deepEqual(
    deepMergeMessages(en, { title: "", section: null, list: ["一"] }),
    { title: "Title", section: { value: "Value" }, list: ["一", "Two"] },
  );
  assert.deepEqual(
    deepMergeMessages(en, { title: {}, section: "wrong shape" }),
    en,
  );
});
