import { describe, expect, test } from "vitest";

import {
  GHOST_API_KEY_MAX_LENGTH,
  GHOST_CONNECTOR_TYPE,
  GHOST_CREDENTIAL_USERNAME,
  GHOST_SITE_URL_MAX_LENGTH,
  isAcceptableGhostApiKey,
  isAcceptableGhostSiteUrl,
} from "./ghost-site-url";

test("the connector type and credential username match the backend", () => {
  expect(GHOST_CONNECTOR_TYPE).toBe("ghost");
  // The platform requires a non-empty username; Ghost ignores it.
  expect(GHOST_CREDENTIAL_USERNAME.trim()).not.toBe("");
  expect(GHOST_CREDENTIAL_USERNAME.length).toBeLessThanOrEqual(200);
});

describe("isAcceptableGhostSiteUrl", () => {
  test.each([
    "https://demo.ghost.io",
    "https://demo.ghost.io/",
    "https://Blog.Example.COM/News/Archive/",
    "https://xn--e1afmkfd.xn--p1ai",
    "https://x.example.org/blog/v1.2/news_a~b",
  ])("accepts %s", (value) => {
    expect(isAcceptableGhostSiteUrl(value)).toBe(true);
  });

  test("the length limit is inclusive", () => {
    const prefix = "https://demo.ghost.io/";
    const ok = prefix + "a".repeat(GHOST_SITE_URL_MAX_LENGTH - prefix.length);
    expect(ok).toHaveLength(GHOST_SITE_URL_MAX_LENGTH);
    expect(isAcceptableGhostSiteUrl(ok)).toBe(true);
    expect(isAcceptableGhostSiteUrl(`${ok}a`)).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["http", "http://demo.ghost.io"],
    ["no scheme", "demo.ghost.io"],
    ["uppercase scheme", "HTTPS://demo.ghost.io"],
    ["leading whitespace", " https://demo.ghost.io"],
    ["trailing whitespace", "https://demo.ghost.io "],
    ["userinfo", "https://user:pw@demo.ghost.io"],
    ["userinfo without password", "https://user@demo.ghost.io"],
    ["query", "https://demo.ghost.io/?a=1"],
    ["fragment", "https://demo.ghost.io/#top"],
    ["port", "https://demo.ghost.io:2368"],
    ["IPv4", "https://127.0.0.1"],
    ["public IPv4", "https://8.8.8.8/blog"],
    ["decimal host", "https://2130706433"],
    ["hex host", "https://0x7f000001"],
    ["IPv6 literal", "https://[::1]"],
    ["localhost", "https://localhost"],
    ["localhost subdomain", "https://blog.localhost"],
    [".local host", "https://blog.local"],
    [".internal host", "https://blog.internal"],
    ["single-label host", "https://blog"],
    ["empty label", "https://demo..ghost.io"],
    ["label starting with a hyphen", "https://-demo.ghost.io"],
    ["dot segment", "https://demo.ghost.io/../ghost"],
    ["empty path segment", "https://demo.ghost.io//x"],
    ["percent sign", "https://demo.ghost.io/%2e%2e"],
    ["backslash", "https://demo.ghost.io\\x"],
    ["non-ASCII host", "https://блог.example.com"],
  ])("rejects %s", (_label, value) => {
    expect(isAcceptableGhostSiteUrl(value)).toBe(false);
  });
});

describe("isAcceptableGhostApiKey", () => {
  test.each([
    "22444f78447824223cefc48062",
    "AbCdEf123",
    "a-b_c.d~e",
    "x".repeat(GHOST_API_KEY_MAX_LENGTH),
  ])("accepts %s", (value) => {
    expect(isAcceptableGhostApiKey(value)).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["a space", "abc def"],
    ["a tab", "abc\tdef"],
    ["a newline", "abc\ndef"],
    ["non-ASCII", "abcé"],
    ["too long", "x".repeat(GHOST_API_KEY_MAX_LENGTH + 1)],
  ])("rejects %s", (_label, value) => {
    expect(isAcceptableGhostApiKey(value)).toBe(false);
  });
});
