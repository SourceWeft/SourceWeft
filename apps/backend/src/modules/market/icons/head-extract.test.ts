import { describe, expect, test } from "vitest";
import {
  classifyPage,
  extractHead,
  extractManifestIcons,
  largestDeclaredSize,
} from "./head-extract";

const PAGE = "https://example.com/start/";

describe("extractHead", () => {
  test("reads icon links, the manifest link and the title from <head>", () => {
    const head = extractHead(
      `<!doctype html><html><head>
        <title>  Example   Product </title>
        <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
        <link rel="shortcut icon" href="favicon.ico">
        <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
        <link rel="mask-icon" href="/mask.svg" color="#000">
        <link rel="manifest" href="/site.webmanifest">
        <link rel="stylesheet" href="/a.css">
      </head><body></body></html>`,
      PAGE,
    );
    expect(head.title).toBe("Example Product");
    expect(head.manifestUrl).toBe("https://example.com/site.webmanifest");
    expect(head.icons).toEqual([
      { rel: "icon", url: "https://example.com/favicon-32.png", size: 32, type: "image/png" },
      { rel: "icon", url: "https://example.com/start/favicon.ico", size: undefined },
      { rel: "apple-touch-icon", url: "https://example.com/apple.png", size: 180 },
      { rel: "mask-icon", url: "https://example.com/mask.svg", size: undefined },
    ]);
  });

  test("ignores <base>: relative references resolve against the fetched address", () => {
    const head = extractHead(
      `<html><head><base href="https://evil.test/"><link rel="icon" href="logo.png"></head></html>`,
      PAGE,
    );
    expect(head.icons.map((i) => i.url)).toEqual(["https://example.com/start/logo.png"]);
  });

  test("never reads og:image, descriptions or anything in <body>", () => {
    const head = extractHead(
      `<html><head>
        <meta property="og:image" content="https://example.com/banner.png">
        <meta name="description" content="A product that does things">
      </head><body><link rel="icon" href="/body-icon.png"></body></html>`,
      PAGE,
    );
    expect(head).toEqual({ icons: [] });
  });

  test("survives malformed and unterminated markup", () => {
    const head = extractHead(
      `<html><head><title>Broken<link rel="icon" href="/x.png"><meta <<<>`,
      PAGE,
    );
    // The unterminated <title> swallows the rest; nothing throws.
    expect(head.icons).toEqual([]);
    expect(extractHead("", PAGE)).toEqual({ icons: [] });
    expect(extractHead("<<<not html>>>", PAGE)).toEqual({ icons: [] });
  });

  test("drops non-http(s) and over-long references", () => {
    const head = extractHead(
      `<head>
        <link rel="icon" href="data:image/png;base64,AAAA">
        <link rel="icon" href="javascript:alert(1)">
        <link rel="icon" href="http://example.com/plain.png">
        <link rel="icon" href="/${"a".repeat(3000)}.png">
      </head>`,
      PAGE,
    );
    expect(head.icons.map((i) => i.url)).toEqual(["http://example.com/plain.png"]);
  });

  test("does not execute scripts or resolve entities into markup", () => {
    const head = extractHead(
      `<head><script>document.write('<link rel=icon href=/evil.png>')</script>
       <link rel="icon" href="/real.png"></head>`,
      PAGE,
    );
    expect(head.icons.map((i) => i.url)).toEqual(["https://example.com/real.png"]);
  });
});

describe("largestDeclaredSize", () => {
  test("takes the largest side and ignores any/garbage", () => {
    expect(largestDeclaredSize("16x16 32x32 180x120")).toBe(180);
    expect(largestDeclaredSize("any")).toBeUndefined();
    expect(largestDeclaredSize(undefined)).toBeUndefined();
  });
});

describe("extractManifestIcons", () => {
  test("resolves against the manifest and skips monochrome icons", () => {
    const icons = extractManifestIcons(
      JSON.stringify({
        icons: [
          { src: "icons/192.png", sizes: "192x192", type: "image/png" },
          { src: "/512.png", sizes: "512x512", purpose: "any maskable" },
          { src: "/mono.png", sizes: "96x96", purpose: "monochrome" },
          { src: 5 },
          "junk",
        ],
      }),
      "https://example.com/static/site.webmanifest",
    );
    expect(icons).toEqual([
      { rel: "manifest-icon", url: "https://example.com/static/icons/192.png", size: 192, type: "image/png" },
      { rel: "manifest-icon", url: "https://example.com/512.png", size: 512 },
    ]);
  });

  test("tolerates malformed manifests", () => {
    expect(extractManifestIcons("{not json", PAGE)).toEqual([]);
    expect(extractManifestIcons("[]", PAGE)).toEqual([]);
    expect(extractManifestIcons('{"icons":"x"}', PAGE)).toEqual([]);
  });
});

describe("classifyPage", () => {
  test("flags parked pages by title", () => {
    for (const title of [
      "example.com - Domain For Sale",
      "This domain is parked",
      "Buy this domain",
      "HugeDomains.com",
    ]) {
      expect(classifyPage({ status: 200, title, headers: {} })).toBe("parked");
    }
  });

  test("flags challenge pages by title and by response", () => {
    expect(classifyPage({ status: 200, title: "Just a moment...", headers: {} })).toBe("challenge");
    expect(classifyPage({ status: 403, title: "x", headers: { server: "cloudflare" } })).toBe("challenge");
    expect(classifyPage({ status: 200, headers: { "cf-mitigated": "challenge" } })).toBe("challenge");
    expect(classifyPage({ status: 429, headers: {} })).toBe("challenge");
  });

  test("leaves ordinary product pages alone", () => {
    expect(classifyPage({ status: 200, title: "Acme — build faster", headers: {} })).toBeUndefined();
    expect(classifyPage({ status: 200, headers: {} })).toBeUndefined();
  });
});
