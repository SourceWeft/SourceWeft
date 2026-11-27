import { describe, expect, test } from "vitest";

import {
  isAcceptableSiteUrl,
  WORDPRESS_CONNECTOR_TYPE,
  WORDPRESS_LOGIN_CONNECTOR_TYPE,
  WORDPRESS_SITE_URL_MAX_LENGTH,
} from "./wordpress-site-url";

test("the connector type constants are the backend types", () => {
  expect(WORDPRESS_CONNECTOR_TYPE).toBe("wordpress");
  expect(WORDPRESS_LOGIN_CONNECTOR_TYPE).toBe("wordpress_login");
});

describe("isAcceptableSiteUrl", () => {
  test.each([
    "https://blog.example.com",
    "https://blog.example.com/",
    "https://Blog.Example.COM/News/Archive/",
    "https://xn--e1afmkfd.xn--p1ai",
    "https://x.example.org/v1.2/news_a~b",
    "https://alice.wordpress.com",
  ])("accepts %s", (value) => {
    expect(isAcceptableSiteUrl(value)).toBe(true);
  });

  test("the length limit is inclusive", () => {
    const prefix = "https://blog.example.com/";
    const ok =
      prefix + "a".repeat(WORDPRESS_SITE_URL_MAX_LENGTH - prefix.length);
    expect(ok).toHaveLength(WORDPRESS_SITE_URL_MAX_LENGTH);
    expect(isAcceptableSiteUrl(ok)).toBe(true);
    expect(isAcceptableSiteUrl(`${ok}a`)).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["http", "http://blog.example.com"],
    ["no scheme", "blog.example.com"],
    ["uppercase scheme", "HTTPS://blog.example.com"],
    ["leading whitespace", " https://blog.example.com"],
    ["trailing whitespace", "https://blog.example.com "],
    ["userinfo", "https://user:pw@blog.example.com"],
    ["userinfo without password", "https://user@blog.example.com"],
    ["query", "https://blog.example.com/?a=1"],
    ["fragment", "https://blog.example.com/#top"],
    ["port", "https://blog.example.com:8443"],
    ["IPv4", "https://127.0.0.1"],
    ["public IPv4", "https://8.8.8.8/news"],
    ["decimal host", "https://2130706433"],
    ["hex host", "https://0x7f000001"],
    ["IPv6 literal", "https://[::1]"],
    ["localhost", "https://localhost"],
    ["localhost subdomain", "https://blog.localhost"],
    [".local host", "https://blog.local"],
    [".internal host", "https://blog.internal"],
    ["single-label host", "https://blog"],
    ["empty label", "https://blog..example.com"],
    ["label starting with a hyphen", "https://-blog.example.com"],
    ["dot segment", "https://blog.example.com/../admin"],
    ["empty path segment", "https://blog.example.com//x"],
    ["percent sign", "https://blog.example.com/%2e%2e"],
    ["backslash", "https://blog.example.com\\x"],
    ["non-ASCII host", "https://блог.example.com"],
  ])("rejects %s", (_label, value) => {
    expect(isAcceptableSiteUrl(value)).toBe(false);
  });
});
