import { describe, expect, test, vi } from "vitest";
import {
  DomainLookupError,
  WELL_KNOWN_LIMITS,
  controlledDomainFetch,
  verifyDnsTxt,
  verifyWellKnown,
  type DomainLookup,
} from "./domain-verify";
import { hashClaimToken, newClaimToken } from "./targets";

const token = newClaimToken();
const hash = hashClaimToken(token);

function lookup(
  parts: Partial<{
    resolveTxt: DomainLookup["resolveTxt"];
    fetch: typeof globalThis.fetch;
  }>,
): DomainLookup {
  const fetch = parts.fetch ?? (async () => new Response("", { status: 404 }));
  return {
    resolveTxt: parts.resolveTxt ?? (async () => []),
    openFetch: () => ({ fetch, close: async () => undefined }),
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

  test("closes its request scope whichever way the lookup ends", async () => {
    const close = vi.fn(async () => undefined);
    const scoped: DomainLookup = {
      resolveTxt: async () => [],
      openFetch: () => ({ fetch: async () => new Response(token), close }),
    };
    await expect(verifyWellKnown("notion.com", hash, scoped)).resolves.toBe("verified");
    const failing: DomainLookup = {
      resolveTxt: async () => [],
      openFetch: () => ({
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        close,
      }),
    };
    await expect(verifyWellKnown("notion.com", hash, failing)).rejects.toBeInstanceOf(
      DomainLookupError,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  test("a domain pointing at a private address is denied before any request", async () => {
    // The default scope: the platform's controlled fetch with the public
    // endpoint policy, here with a resolver that answers a private address.
    const scoped: DomainLookup = {
      resolveTxt: async () => [],
      openFetch: () =>
        controlledDomainFetch(
          { enforceAddressChecks: true, allowedInternalOrigins: [] },
          async () => [{ address: "10.0.0.8", family: 4 }],
        ),
    };
    await expect(
      verifyWellKnown("intranet-looking.example", hash, scoped),
    ).rejects.toMatchObject({
      name: "DomainLookupError",
      message: expect.stringContaining("is not an address this service may fetch"),
    });
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
