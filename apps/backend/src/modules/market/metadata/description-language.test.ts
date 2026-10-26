import assert from "node:assert/strict";
import { test } from "vitest";
import { detectDescriptionLanguage } from "./description-language";

test("Latin text is English, the default", () => {
  assert.equal(detectDescriptionLanguage("Search and read your Notion pages."), "en");
  assert.equal(detectDescriptionLanguage(""), "en");
  assert.equal(detectDescriptionLanguage("1234 ---"), "en");
});

test("Chinese, Japanese and Korean are told apart by script", () => {
  assert.equal(detectDescriptionLanguage("搜索并读取你的 Notion 页面,支持数据库查询"), "zh");
  assert.equal(detectDescriptionLanguage("Notion のページを検索して読み取ります"), "ja");
  assert.equal(detectDescriptionLanguage("Notion 페이지를 검색하고 읽습니다"), "ko");
});

test("a few foreign characters in English do not change it", () => {
  assert.equal(
    detectDescriptionLanguage("Query the 飞书 (Feishu) API from your assistant with an access token"),
    "en",
  );
});

test("URLs and paths are not counted", () => {
  assert.equal(
    detectDescriptionLanguage("读取文件 https://github.com/acme/server-for-everything acme/server"),
    "zh",
  );
});

test("other scripts are undetermined, not guessed", () => {
  assert.equal(detectDescriptionLanguage("Поиск и чтение страниц Notion"), "und");
});
