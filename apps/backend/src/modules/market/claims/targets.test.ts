import { describe, expect, test } from "vitest";
import {
  claimTargetsFor,
  claimTokenExpiry,
  dnsRecordName,
  githubOwnerOfIdentifier,
  githubOwnerOfRepoUrl,
  hashClaimToken,
  namespaceDomain,
  newClaimToken,
  textCarriesToken,
  wellKnownUrl,
} from "./targets";

describe("claim targets", () => {
  test("io.github namespaces name a GitHub owner, not a domain", () => {
    expect(githubOwnerOfIdentifier("io.github.Acme/server")).toBe("acme");
    expect(githubOwnerOfIdentifier("com.notion/mcp")).toBeNull();
    expect(githubOwnerOfIdentifier("io.github.-bad/server")).toBeNull();
    expect(namespaceDomain("io.github.acme/server")).toBeNull();
    expect(
      claimTargetsFor({ identifier: "io.github.acme/server", repoUrl: null }),
    ).toEqual({ github: { owner: "acme", source: "namespace" }, domain: null });
  });

  test("a declared github.com repository names its owner", () => {
    expect(githubOwnerOfRepoUrl("https://github.com/Notion/notion-mcp")).toBe(
      "notion",
    );
    expect(githubOwnerOfRepoUrl("https://gitlab.com/a/b")).toBeNull();
    expect(githubOwnerOfRepoUrl("http://github.com/a/b")).toBeNull();
    expect(githubOwnerOfRepoUrl("https://github.com/only-owner")).toBeNull();
    expect(githubOwnerOfRepoUrl("not a url")).toBeNull();
    expect(
      claimTargetsFor({
        identifier: "com.example/thing",
        repoUrl: "https://github.com/example-org/thing",
      }),
    ).toEqual({
      github: { owner: "example-org", source: "repository" },
      domain: "example.com",
    });
  });

  test("a reverse-DNS namespace is a domain", () => {
    expect(namespaceDomain("com.notion/mcp")).toBe("notion.com");
    expect(namespaceDomain("Dev.Mcp.Example/x")).toBe("example.mcp.dev");
    expect(namespaceDomain("ai.hf/hub")).toBe("hf.ai");
  });

  test("implausible or local namespaces are not domains", () => {
    expect(namespaceDomain("notion/mcp")).toBeNull(); // one label
    expect(namespaceDomain("local.thing/x")).toBeNull();
    expect(namespaceDomain("localhost.api/x")).toBeNull();
    expect(namespaceDomain("1.2.3.4/x")).toBeNull(); // IP literal
    expect(namespaceDomain("com.bad_label/x")).toBeNull();
    expect(namespaceDomain("/x")).toBeNull();
  });

  test("record name and well-known URL are the exact documented ones", () => {
    expect(dnsRecordName("notion.com")).toBe("_sourceweft-claim.notion.com");
    expect(wellKnownUrl("notion.com")).toBe(
      "https://notion.com/.well-known/sourceweft-claim",
    );
  });
});

describe("claim tokens", () => {
  test("are fresh, prefixed and only ever compared by hash", () => {
    const a = newClaimToken();
    const b = newClaimToken();
    expect(a).toMatch(/^sourceweft-claim-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(hashClaimToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimToken(a)).not.toBe(hashClaimToken(b));
  });

  test("expire seven days after issue", () => {
    const now = new Date("2026-10-24T00:00:00.000Z");
    expect(claimTokenExpiry(now).toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  test("published text must carry the token as a whole line or record", () => {
    const token = newClaimToken();
    const hash = hashClaimToken(token);
    expect(textCarriesToken(token, hash)).toBe(true);
    expect(textCarriesToken(`  ${token}\n`, hash)).toBe(true);
    expect(textCarriesToken(`"${token}"`, hash)).toBe(true);
    expect(textCarriesToken(`v=spf1 -all\n${token}`, hash)).toBe(true);
    expect(textCarriesToken(`prefix ${token}`, hash)).toBe(false);
    expect(textCarriesToken(`${token}x`, hash)).toBe(false);
    expect(textCarriesToken(newClaimToken(), hash)).toBe(false);
    expect(textCarriesToken("", hash)).toBe(false);
  });
});
