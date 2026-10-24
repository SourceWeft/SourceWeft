import { describe, expect, test, vi } from "vitest";
import {
  DomainLookupError,
  WELL_KNOWN_LIMITS,
  verifyDnsTxt,
  verifyWellKnown,
  type DomainLookup,
} from "./domain-verify";
import { hashClaimToken, newClaimToken } from "./targets";

const token = newClaimToken();
const hash = hashClaimToken(token);

function lookup(parts: Partial<DomainLookup>): DomainLookup {
  return {
    resolveTxt: vi.fn(async () => []),
    fetch: vi.fn(async () => new Response("", { status: 404 })),
    ...parts,
  };
}

describe("DNS TXT verification", () => {
  test("reads exactly the _sourceweft-claim record and finds the token", async () => {
    const resolveTxt = vi.fn(async (name: string) => {
      expect(name).toBe("_sourceweft-claim.notion.com");
      return [["v=spf1 -all"], [token.slice(0, 20), token.slice(20)]];
    });
    await expect(
      verifyDnsTxt("notion.com", hash, lookup({ resolveTxt })),
    ).resolves.toBe("verified");
    expect(resolveTxt).toHaveBeenCalledTimes(1);
  });

  test("another token, or none, is not found", async () => {
    await expect(
      verifyDnsTxt(
        "notion.com",
        hash,
        lookup({ resolveTxt: async () => [[newClaimToken()]] }),
      ),
    ).resolves.toBe("not_found");
    await expect(
      verifyDnsTxt("notion.com", hash, lookup({ resolveTxt: async () => [] })),
    ).resolves.toBe("not_found");
  });

  test("a missing name is not found; a broken resolver is a lookup failure", async () => {
    const missing = Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    await expect(
      verifyDnsTxt(
        "notion.com",
        hash,
        lookup({
          resolveTxt: async () => {
            throw missing;
          },
        }),
      ),
    ).resolves.toBe("not_found");
    const broken = Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
    await expect(
      verifyDnsTxt(
        "notion.com",
        hash,
        lookup({
          resolveTxt: async () => {
            throw broken;
          },
        }),
      ),
    ).rejects.toBeInstanceOf(DomainLookupError);
  });
});

describe("well-known verification", () => {
  test("fetches exactly https://<domain>/.well-known/sourceweft-claim, no redirects", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://notion.com/.well-known/sourceweft-claim",
      );
      expect(init?.redirect).toBe("manual");
      expect(init?.method).toBe("GET");
      return new Response(`${token}\n`, { status: 200 });
    });
    await expect(
      verifyWellKnown("notion.com", hash, lookup({ fetch })),
    ).resolves.toBe("verified");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a redirect, a 404 or another token is not found", async () => {
    for (const response of [
      new Response("", { status: 302, headers: { location: "https://x/" } }),
      new Response("", { status: 404 }),
      new Response(newClaimToken(), { status: 200 }),
      new Response(`<html>${token}</html>`, { status: 200 }),
    ]) {
      await expect(
        verifyWellKnown("notion.com", hash, lookup({ fetch: async () => response })),
      ).resolves.toBe("not_found");
    }
  });

  test("reads at most the body limit", async () => {
    const padding = "x".repeat(WELL_KNOWN_LIMITS.bodyBytes);
    await expect(
      verifyWellKnown(
        "notion.com",
        hash,
        lookup({
          fetch: async () => new Response(`${padding}\n${token}`, { status: 200 }),
        }),
      ),
    ).resolves.toBe("not_found");
  });

  test("a network failure is a lookup failure, not a verdict", async () => {
    await expect(
      verifyWellKnown(
        "notion.com",
        hash,
        lookup({
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(DomainLookupError);
  });
});
