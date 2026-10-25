import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  isAllowableRuleHost,
  sidecarAllowEntry,
  canonicalNetworkHost,
  matchesAnyNetworkPattern,
  matchesNetworkPattern,
} from "./network-policy";

describe("canonicalNetworkHost", () => {
  test("lower-cases and strips brackets and the root dot", () => {
    expect(canonicalNetworkHost(" API.Example.COM. ")).toBe("api.example.com");
    expect(canonicalNetworkHost("[2001:DB8::1]")).toBe("2001:db8::1");
    expect(canonicalNetworkHost("8.8.8.8")).toBe("8.8.8.8");
  });
  test("refuses values that are not a connectable host", () => {
    for (const value of [
      "",
      ".",
      "a b.com",
      "a/b.com",
      "a@b.com",
      "*.example.com",
      "a..com",
      ".a.com",
      "exa;mple.com",
      "x".repeat(254),
      "[nonsense:zz]",
    ])
      expect(canonicalNetworkHost(value), value).toBeNull();
  });
});

describe("matchesNetworkPattern (sandbox runtime semantics)", () => {
  test("exact host, case-insensitive, any port", () => {
    expect(matchesNetworkPattern("Example.com", 443, "example.com")).toBe(true);
    expect(matchesNetworkPattern("example.com", 8080, "EXAMPLE.com")).toBe(
      true,
    );
    expect(matchesNetworkPattern("www.example.com", 443, "example.com")).toBe(
      false,
    );
    expect(
      matchesNetworkPattern("example.com.evil.io", 443, "example.com"),
    ).toBe(false);
  });

  test("a wildcard covers strict subdomains only, not the apex", () => {
    expect(matchesNetworkPattern("a.example.com", 443, "*.example.com")).toBe(
      true,
    );
    expect(matchesNetworkPattern("a.b.example.com", 443, "*.example.com")).toBe(
      true,
    );
    expect(matchesNetworkPattern("example.com", 443, "*.example.com")).toBe(
      false,
    );
    expect(matchesNetworkPattern("badexample.com", 443, "*.example.com")).toBe(
      false,
    );
    expect(
      matchesNetworkPattern("a.example.com.evil.io", 443, "*.example.com"),
    ).toBe(false);
  });

  test("a bare * or empty pattern never allows", () => {
    expect(matchesNetworkPattern("example.com", 443, "*")).toBe(false);
    expect(matchesNetworkPattern("example.com", 443, "")).toBe(false);
    expect(matchesNetworkPattern("example.com", 443, "*:443")).toBe(false);
  });

  test("a wildcard never matches an IP literal", () => {
    expect(matchesNetworkPattern("1.2.3.4", 443, "*.2.3.4")).toBe(false);
    expect(matchesNetworkPattern("::ffff:1.2.3.4", 443, "*.2.3.4")).toBe(false);
    expect(matchesNetworkPattern("8.8.8.8", 443, "8.8.8.8")).toBe(true);
    expect(matchesNetworkPattern("2001:db8::1", 443, "[2001:db8::1]")).toBe(
      true,
    );
  });

  test("a port suffix restricts the pattern to that port", () => {
    expect(matchesNetworkPattern("example.com", 443, "example.com:443")).toBe(
      true,
    );
    expect(matchesNetworkPattern("example.com", 80, "example.com:443")).toBe(
      false,
    );
    expect(
      matchesNetworkPattern("a.example.com", 8443, "*.example.com:8443"),
    ).toBe(true);
    expect(matchesNetworkPattern("2001:db8::1", 443, "[2001:db8::1]:443")).toBe(
      true,
    );
    expect(matchesNetworkPattern("2001:db8::1", 80, "[2001:db8::1]:443")).toBe(
      false,
    );
    // A smuggled suffix is not a port.
    expect(
      matchesNetworkPattern("example.com", 443, "example.com:443.evil.io"),
    ).toBe(false);
  });

  test("an unusable subject host matches nothing", () => {
    expect(matchesNetworkPattern("", 443, "example.com")).toBe(false);
    expect(matchesNetworkPattern("a b", 443, "*.b")).toBe(false);
  });

  test("any-of", () => {
    expect(matchesAnyNetworkPattern("a.x.io", 443, ["y.io", "*.x.io"])).toBe(
      true,
    );
    expect(matchesAnyNetworkPattern("a.x.io", 443, [])).toBe(false);
  });
});

const SRT_MODULE = new URL(
  "../../../../desktop/sandbox-sidecar/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js",
  import.meta.url,
);

describe("sidecarAllowEntry", () => {
  test("keeps dotted hosts and wildcards, brackets IPv6, drops what the runtime would drop", () => {
    expect(sidecarAllowEntry("API.Example.com")).toBe("api.example.com");
    expect(sidecarAllowEntry("*.example.com")).toBe("*.example.com");
    expect(sidecarAllowEntry("2001:DB8::1")).toBe("[2001:db8::1]");
    expect(sidecarAllowEntry("8.8.8.8")).toBe("8.8.8.8");
    for (const dropped of [
      "intranet",
      "localhost",
      "*",
      "*.com",
      "*.",
      "a.*.example.com",
      "",
      ".example.com",
      "exa mple.com",
      "not:an:ip",
    ])
      expect(sidecarAllowEntry(dropped), dropped).toBeNull();
  });

  test("only dotted host names can back a standing rule", () => {
    expect(isAllowableRuleHost("api.example.com")).toBe(true);
    for (const host of [
      "intranet",
      "localhost",
      "8.8.8.8",
      "2001:db8::1",
      "[::1]",
      "",
      "*.example.com",
    ])
      expect(isAllowableRuleHost(host), host).toBe(false);
  });

  test.skipIf(!existsSync(SRT_MODULE))(
    "agrees with the runtime's own list check",
    async () => {
      const srt = (await import(pathToFileURL(SRT_MODULE.pathname).href)) as {
        isValidAllowedDomainEntry: (value: string) => boolean;
      };
      for (const entry of [
        "api.example.com",
        "*.example.com",
        "2001:db8::1",
        "8.8.8.8",
        "intranet",
        "localhost",
        "*.com",
        "*",
        "a.*.example.com",
        "foo",
        ".example.com",
        "example.com.",
        "xn--bcher-kva.example",
      ]) {
        const ours = sidecarAllowEntry(entry);
        // Whatever we emit, the runtime keeps; what we drop is never kept for us.
        if (ours) expect(srt.isValidAllowedDomainEntry(ours), entry).toBe(true);
        else if (!entry.includes(":") && entry !== "localhost")
          expect(srt.isValidAllowedDomainEntry(entry), entry).toBe(false);
      }
    },
  );
});
