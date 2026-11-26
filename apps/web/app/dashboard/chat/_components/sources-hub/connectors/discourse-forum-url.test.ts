import { describe, expect, test } from "vitest";

import {
  DISCOURSE_FORUM_URL_MAX_LENGTH,
  isAcceptableForumUrl,
} from "./discourse-forum-url";

describe("isAcceptableForumUrl", () => {
  test.each([
    "https://forum.example.com",
    "https://forum.example.com/",
    "https://Forum.Example.COM/Community/Forum/",
    "https://xn--e1afmkfd.xn--p1ai",
    "https://x.example.org/v1.2/forum_a~b",
  ])("accepts %s", (value) => {
    expect(isAcceptableForumUrl(value)).toBe(true);
  });

  test("the length limit is inclusive", () => {
    const prefix = "https://forum.example.com/";
    const ok =
      prefix + "a".repeat(DISCOURSE_FORUM_URL_MAX_LENGTH - prefix.length);
    expect(ok).toHaveLength(DISCOURSE_FORUM_URL_MAX_LENGTH);
    expect(isAcceptableForumUrl(ok)).toBe(true);
    expect(isAcceptableForumUrl(`${ok}a`)).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["http", "http://forum.example.com"],
    ["no scheme", "forum.example.com"],
    ["uppercase scheme", "HTTPS://forum.example.com"],
    ["leading whitespace", " https://forum.example.com"],
    ["trailing whitespace", "https://forum.example.com "],
    ["userinfo", "https://user:pw@forum.example.com"],
    ["userinfo without password", "https://user@forum.example.com"],
    ["query", "https://forum.example.com/?a=1"],
    ["fragment", "https://forum.example.com/#top"],
    ["port", "https://forum.example.com:8443"],
    ["IPv4", "https://127.0.0.1"],
    ["public IPv4", "https://8.8.8.8/forum"],
    ["decimal host", "https://2130706433"],
    ["hex host", "https://0x7f000001"],
    ["IPv6 literal", "https://[::1]"],
    ["localhost", "https://localhost"],
    ["localhost subdomain", "https://forum.localhost"],
    [".local host", "https://forum.local"],
    [".internal host", "https://forum.internal"],
    ["single-label host", "https://forum"],
    ["empty label", "https://forum..example.com"],
    ["label starting with a hyphen", "https://-forum.example.com"],
    ["dot segment", "https://forum.example.com/../admin"],
    ["empty path segment", "https://forum.example.com//x"],
    ["percent sign", "https://forum.example.com/%2e%2e"],
    ["backslash", "https://forum.example.com\\x"],
    ["non-ASCII host", "https://форум.example.com"],
  ])("rejects %s", (_label, value) => {
    expect(isAcceptableForumUrl(value)).toBe(false);
  });
});
