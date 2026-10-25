import { describe, expect, test } from "vitest";
import {
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
