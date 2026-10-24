import { describe, expect, test } from "vitest";
import {
  brandLabel,
  hostIsUnder,
  httpsHostOf,
  registrableDomainOf,
  wwwTwin,
} from "./site-domain";

describe("registrableDomainOf", () => {
  test("uses the public suffix list, private section included", () => {
    expect(registrableDomainOf("mcp.notion.com")).toBe("notion.com");
    expect(registrableDomainOf("shop.example.co.uk")).toBe("example.co.uk");
    // Two projects on a shared host are two sites.
    expect(registrableDomainOf("a.github.io")).toBe("a.github.io");
    expect(registrableDomainOf("b.github.io")).toBe("b.github.io");
    expect(registrableDomainOf("x.y.vercel.app")).toBe("y.vercel.app");
    expect(registrableDomainOf("svc.acct.workers.dev")).toBe("acct.workers.dev");
  });

  test("has none for IP literals, bare suffixes and single labels", () => {
    expect(registrableDomainOf("127.0.0.1")).toBeUndefined();
    expect(registrableDomainOf("github.io")).toBeUndefined();
    expect(registrableDomainOf("localhost")).toBeUndefined();
  });
});

describe("hosts", () => {
  test("httpsHostOf accepts only plain https on the default port", () => {
    expect(httpsHostOf("https://Example.COM./x")).toBe("example.com");
    expect(httpsHostOf("http://example.com")).toBeUndefined();
    expect(httpsHostOf("https://u:p@example.com")).toBeUndefined();
    expect(httpsHostOf("https://example.com:8443")).toBeUndefined();
    expect(httpsHostOf("not a url")).toBeUndefined();
  });

  test("hostIsUnder, wwwTwin and brandLabel", () => {
    expect(hostIsUnder("mcp.notion.com", "notion.com")).toBe(true);
    expect(hostIsUnder("notion.com", "notion.com")).toBe(true);
    expect(hostIsUnder("evilnotion.com", "notion.com")).toBe(false);
    expect(wwwTwin("example.com")).toBe("www.example.com");
    expect(wwwTwin("www.example.com")).toBe("example.com");
    expect(brandLabel("notion.so")).toBe(brandLabel("notion.com"));
  });
});
