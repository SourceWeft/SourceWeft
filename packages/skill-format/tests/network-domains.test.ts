import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeSkillNetworkDomain,
  parseSkillFrontmatter,
  readSkillNetworkDomains,
} from "../src";

describe("normalizeSkillNetworkDomain", () => {
  it("accepts hosts and strict-subdomain wildcards, lower-cased", () => {
    assert.equal(
      normalizeSkillNetworkDomain("API.Example.com"),
      "api.example.com",
    );
    assert.equal(
      normalizeSkillNetworkDomain(" *.example.co.uk "),
      "*.example.co.uk",
    );
    assert.equal(
      normalizeSkillNetworkDomain("xn--bcher-kva.example"),
      "xn--bcher-kva.example",
    );
  });

  it("rejects everything that could widen or confuse the allow list", () => {
    for (const value of [
      "",
      "*",
      "*.com",
      "*.",
      "**.example.com",
      "a.*.example.com",
      "example.*",
      "localhost",
      "com",
      "127.0.0.1",
      "*.127.0.0.1",
      "2130706433",
      "0x7f.0.0.1",
      "[::1]",
      "::1",
      "example.com:443",
      "https://example.com",
      "example.com/path",
      "user@example.com",
      "exa mple.com",
      "-bad.example.com",
      "bad-.example.com",
      "a..example.com",
      ".example.com",
      "example.com.",
      "bücher.example",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(130)}com`,
    ])
      assert.equal(normalizeSkillNetworkDomain(value), null, value);
  });
});

describe("readSkillNetworkDomains", () => {
  it("is empty when the key is absent or there is no frontmatter", () => {
    assert.deepEqual(readSkillNetworkDomains(null), {
      domains: [],
      issues: [],
    });
    assert.deepEqual(readSkillNetworkDomains({ name: "x" }), {
      domains: [],
      issues: [],
    });
  });

  it("reads a YAML list from real SKILL.md frontmatter", () => {
    const frontmatter = parseSkillFrontmatter(
      "---\nname: pdf\nnetwork-domains:\n  - api.example.com\n  - '*.cdn.example.com'\n  - API.EXAMPLE.COM\n---\nBody",
    );
    assert.deepEqual(readSkillNetworkDomains(frontmatter), {
      domains: ["api.example.com", "*.cdn.example.com"],
      issues: [],
    });
  });

  it("drops invalid entries and reports them without echoing their text", () => {
    const result = readSkillNetworkDomains({
      "network-domains": [
        "ok.example.com",
        "*",
        "*.com",
        "10.0.0.1",
        7,
        "x".repeat(300),
      ],
    });
    assert.deepEqual(result.domains, ["ok.example.com"]);
    assert.deepEqual(result.issues, [
      { key: "network-domains", code: "ENTRY_INVALID", index: 1 },
      { key: "network-domains", code: "ENTRY_INVALID", index: 2 },
      { key: "network-domains", code: "ENTRY_INVALID", index: 3 },
      { key: "network-domains", code: "ENTRY_NOT_A_STRING", index: 4 },
      { key: "network-domains", code: "ENTRY_TOO_LONG", index: 5 },
    ]);
  });

  it("keeps at most 50 entries", () => {
    const entries = Array.from({ length: 53 }, (_, i) => `h${i}.example.com`);
    const result = readSkillNetworkDomains({ "network-domains": entries });
    assert.equal(result.domains.length, 50);
    assert.deepEqual(
      result.issues.map((issue) => [issue.code, issue.index]),
      [
        ["TOO_MANY_ENTRIES", 50],
        ["TOO_MANY_ENTRIES", 51],
        ["TOO_MANY_ENTRIES", 52],
      ],
    );
  });

  it("treats a non-list declaration as no domains", () => {
    for (const value of ["api.example.com", { host: "x.example.com" }, 3]) {
      assert.deepEqual(readSkillNetworkDomains({ "network-domains": value }), {
        domains: [],
        issues: [{ key: "network-domains", code: "NOT_A_LIST" }],
      });
    }
  });
});
