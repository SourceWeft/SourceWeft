import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BRAND_STOP_LIST,
  brandOfDomain,
  brandPosition,
  compareProductGroupMembers,
  entryCarriesBrand,
  githubRepoOwner,
  groupAdmits,
  isProductGroupMember,
  namespaceGithubOwner,
  productGroupFor,
  productGroupOf,
  productGroupsOf,
  slugTokens,
  type ProductGroupEntry,
} from "./product-group";

let sequence = 0;
function entry(
  identifier: string,
  name: string,
  patch: Partial<ProductGroupEntry> = {},
): ProductGroupEntry {
  sequence += 1;
  return {
    id: `id-${String(sequence).padStart(3, "0")}`,
    identifier,
    name,
    repoUrl: null,
    publishedAt: new Date(Date.UTC(2026, 8, 3, 13, 0, sequence)),
    publisher: null,
    ...patch,
  };
}

function publisher(domain: string, endpointMatch: boolean) {
  return { domain, source: "registry-namespace" as const, endpointMatch };
}

function official(
  identifier: string,
  name: string,
  domain: string,
  patch: Partial<ProductGroupEntry> = {},
) {
  return entry(identifier, name, {
    publisher: publisher(domain, true),
    ...patch,
  });
}

// The catalog's Notion case: the publisher's own server, the third-party
// integrations whose name or slug says Notion, and the servers that only
// mention Notion in their summary.
const NOTION_OFFICIAL = official("com.notion/mcp", "Mcp", "notion.com", {
  publishedAt: new Date("2026-09-03T13:37:30.930Z"),
});
const NOTION_INTEGRATIONS = [
  entry("ai.smithery/smithery-notion", "Smithery Notion", {
    repoUrl: "https://github.com/smithery-ai/mcp-servers",
    publisher: publisher("smithery.ai", false),
  }),
  entry("com.mcparmory/notion", "Notion", {
    repoUrl: "https://github.com/mcparmory/registry",
    publisher: publisher("mcparmory.com", false),
  }),
  entry("io.github.ai-aviate/better-notion", "Better Notion", {
    repoUrl: "https://github.com/ai-aviate/better-mcp-notion",
  }),
  entry("io.github.awkoy/notion-mcp-server", "Notion Mcp Server", {
    repoUrl: "https://github.com/awkoy/notion-mcp-server",
  }),
  entry("io.github.infoinlet-marketplace/mcp-notion", "Mcp Notion", {
    repoUrl: "https://github.com/infoinlet-marketplace/marketplace",
  }),
  entry("io.github.misterwigglesworth/easy-notion", "Easy Notion", {
    repoUrl: "https://github.com/Grey-Iris/easy-notion-mcp",
  }),
  entry("io.github.n24q02m/better-notion-mcp", "Better Notion Mcp", {
    repoUrl: "https://github.com/n24q02m/better-notion-mcp.git",
  }),
  entry("io.github.pipeworx-io/notion_connect", "Notion_connect", {
    repoUrl: "https://github.com/pipeworx-io/mcp-notion_connect",
  }),
  entry("io.github.sadri-dridi/notion-url-shape", "Notion URL Shape", {
    repoUrl: "https://github.com/sadri-dridi/named-mcp-utilities",
  }),
  entry("io.github.shck-dev/notion-mcp", "Notion Mcp", {
    repoUrl: "https://github.com/shck-dev/notion-mcp",
  }),
  // A camelCase name and a slug that says nothing: the name decides.
  entry("io.github.suekou/server", "NotionMCP", {
    repoUrl: "https://github.com/suekou/notion-mcp-server",
  }),
  // Underscores and a name that says nothing: the slug decides.
  entry("io.github.danhilse/notion_mcp", "Tasks for agents"),
  // Published under the product's own domain without running on it.
  entry("com.notion/sdk-bridge", "SDK bridge", {
    publisher: publisher("notion.com", false),
  }),
];
const SUMMARY_ONLY_MENTIONS = [
  entry("ai.context-link/context-link", "Context Link", {
    publisher: publisher("context-link.ai", false),
  }),
  entry("dev.claw-link/clawlink", "ClawLink", {
    repoUrl: "https://github.com/hith3sh/clawlink",
    publisher: publisher("claw-link.dev", false),
  }),
  entry("io.github.havilandsoftware/mcp-server-innoday", "InnoDay"),
  entry("io.github.kfuras/notipo", "Notipo", {
    repoUrl: "https://github.com/kfuras/notipo-app",
  }),
  entry("io.github.lildaddyo/braintube-mcp", "BrainTube"),
  // The brand inside the namespace account, not the slug.
  entry("io.github.quietnotion/barevalue", "Barevalue", {
    repoUrl: "https://github.com/quietnotion/barevalue-mcp",
  }),
  entry("io.github.Ranork/remnus", "Remnus"),
  entry(
    "io.github.renezander030/agentic-task-system",
    "Agentic Task System (ATS)",
  ),
  // The brand as a prefix of a longer word.
  entry("io.github.acme/notionally", "Notionally"),
  entry("io.github.acme/notions", "Notions board"),
];

test("slug tokens split on separators and camelCase, never inside a word", () => {
  assert.deepEqual(slugTokens("Notion MCP Server"), [
    "notion",
    "mcp",
    "server",
  ]);
  assert.deepEqual(slugTokens("better-notion"), ["better", "notion"]);
  assert.deepEqual(slugTokens("notion_connect"), ["notion", "connect"]);
  assert.deepEqual(slugTokens("NotionMCP"), ["notion", "mcp"]);
  assert.deepEqual(slugTokens("MCPNotion"), ["mcp", "notion"]);
  assert.deepEqual(slugTokens("notionally"), ["notionally"]);
  assert.deepEqual(slugTokens("notion2"), ["notion2"]);
  assert.deepEqual(slugTokens("Agentic Task System (ATS)"), [
    "agentic",
    "task",
    "system",
    "ats",
  ]);
  assert.deepEqual(slugTokens(""), []);
});

test("the brand is the domain's registrable label", () => {
  assert.equal(brandOfDomain("notion.com"), "notion");
  assert.equal(brandOfDomain("NOTION.COM."), "notion");
  assert.equal(brandOfDomain("mcp.notion.com"), "notion");
  assert.equal(brandOfDomain("notion.so"), "notion");
  assert.equal(brandOfDomain("smithery.ai"), "smithery");
  assert.equal(brandOfDomain("claw-link.dev"), "claw-link");
  assert.equal(brandOfDomain("acme.co.uk"), "acme");
  assert.equal(brandOfDomain("acme.com.au"), "acme");
  assert.equal(brandOfDomain("docs.acme.co.uk"), "acme");
  // A short second-level label that is a brand, not a public suffix.
  assert.equal(brandOfDomain("docs.ibm.com"), null);
  assert.equal(brandOfDomain("docs.asana.com"), "asana");
});

test("short and generic labels key no group", () => {
  // ai.mcp → mcp.ai, cloud.tools → tools.cloud: the stop-list.
  assert.equal(brandOfDomain("mcp.ai"), null);
  assert.equal(brandOfDomain("tools.cloud"), null);
  assert.equal(brandOfDomain("mcp.com.ai"), null);
  assert.equal(brandOfDomain("api.dev"), null);
  // Too short, hyphens not counted.
  assert.equal(brandOfDomain("box.com"), null);
  assert.equal(brandOfDomain("a-b.com"), null);
  // Malformed.
  assert.equal(brandOfDomain("localhost"), null);
  assert.equal(brandOfDomain(""), null);
  assert.equal(brandOfDomain("-bad-.com"), null);
  assert.equal(brandOfDomain("no tion.com"), null);
  for (const word of ["mcp", "server", "api", "tools", "cloud"]) {
    assert.ok(BRAND_STOP_LIST.has(word), word);
  }
});

test("whole-token brand matching on name or identifier tail", () => {
  const group = productGroupOf(NOTION_OFFICIAL)!;
  for (const [identifier, name] of [
    ["io.github.o/x", "notion"],
    ["io.github.o/notion-mcp-server", "x"],
    ["io.github.o/better-notion", "x"],
    ["io.github.o/smithery-notion", "x"],
    ["io.github.o/x", "NotionMCP"],
    ["io.github.o/x", "The Notion Server"],
    ["io.github.o/notion_connect", "x"],
  ]) {
    assert.ok(
      entryCarriesBrand(group, { identifier: identifier!, name: name! }),
      identifier,
    );
  }
  for (const [identifier, name] of [
    ["io.github.o/notionally", "x"],
    ["io.github.o/x", "Notionally"],
    ["io.github.o/notions", "Notions"],
    ["io.github.o/x", "notion2"],
    // The namespace is not the tail.
    ["io.github.notion/x", "x"],
    ["com.notion/x", "x"],
    ["io.github.o/x", ""],
  ]) {
    assert.equal(
      entryCarriesBrand(group, { identifier: identifier!, name: name! }),
      false,
      identifier,
    );
  }
});

test("a hyphenated brand must appear as consecutive tokens", () => {
  const group = productGroupOf(
    official("dev.claw-link/clawlink", "ClawLink", "claw-link.dev"),
  )!;
  assert.deepEqual(group.brandTokens, ["claw", "link"]);
  assert.ok(
    entryCarriesBrand(group, { identifier: "io.github.o/x", name: "ClawLink" }),
  );
  assert.ok(
    entryCarriesBrand(group, {
      identifier: "io.github.o/claw-link-tools",
      name: "x",
    }),
  );
  assert.equal(
    entryCarriesBrand(group, {
      identifier: "io.github.o/link-claw",
      name: "Link Claw",
    }),
    false,
  );
  assert.equal(
    entryCarriesBrand(group, { identifier: "io.github.o/claw", name: "Claw" }),
    false,
  );
});

test("repository owners come from github.com URLs and io.github namespaces", () => {
  assert.equal(
    githubRepoOwner("https://github.com/MakeNotion/notion-mcp-server"),
    "makenotion",
  );
  assert.equal(githubRepoOwner("https://www.github.com/acme/x.git"), "acme");
  assert.equal(githubRepoOwner("https://gitlab.com/acme/x"), null);
  assert.equal(githubRepoOwner("https://github.com/"), null);
  assert.equal(githubRepoOwner("not a url"), null);
  assert.equal(githubRepoOwner(null), null);
  assert.equal(
    namespaceGithubOwner("io.github.MakeNotion/server"),
    "makenotion",
  );
  assert.equal(namespaceGithubOwner("com.notion/mcp"), null);
  assert.equal(namespaceGithubOwner("io.github.acme"), null);
});

test("only an official server with a usable brand defines a group", () => {
  assert.deepEqual(productGroupOf(NOTION_OFFICIAL), {
    domain: "notion.com",
    brand: "notion",
    brandTokens: ["notion"],
    officialIdentifier: "com.notion/mcp",
    repoOwner: null,
  });
  assert.equal(
    productGroupOf(
      entry("com.notion/other", "Other", {
        publisher: publisher("notion.com", false),
      }),
    ),
    null,
  );
  assert.equal(productGroupOf(entry("io.github.o/x", "x")), null);
  assert.equal(
    productGroupOf(official("ai.mcp/server", "MCP", "mcp.ai")),
    null,
  );
  assert.equal(productGroupOf(official("com.box/mcp", "Box", "box.com")), null);
  assert.equal(
    productGroupOf(
      official("com.acme/mcp", "Acme", "acme.com", {
        repoUrl: "https://github.com/Acme-Inc/mcp",
      }),
    )?.repoOwner,
    "acme-inc",
  );
});

test("the Notion fixture: official plus 13 integrations, summary mentions excluded", () => {
  const officials = [NOTION_OFFICIAL];
  const group = productGroupOf(NOTION_OFFICIAL)!;
  assert.equal(NOTION_INTEGRATIONS.length, 13);
  assert.ok(isProductGroupMember(group, NOTION_OFFICIAL, officials));
  for (const member of NOTION_INTEGRATIONS) {
    assert.ok(groupAdmits(group, member), member.identifier);
    assert.ok(
      isProductGroupMember(group, member, officials),
      member.identifier,
    );
    assert.equal(
      productGroupFor(member, officials)?.domain,
      "notion.com",
      member.identifier,
    );
  }
  for (const other of SUMMARY_ONLY_MENTIONS) {
    assert.equal(groupAdmits(group, other), false, other.identifier);
    assert.equal(
      isProductGroupMember(group, other, officials),
      false,
      other.identifier,
    );
    assert.equal(productGroupFor(other, officials), null, other.identifier);
  }
});

test("servers sharing the official server's repository owner join", () => {
  const acme = official("com.acme/mcp", "Acme", "acme.com", {
    repoUrl: "https://github.com/Acme-Inc/mcp-server",
  });
  const group = productGroupOf(acme)!;
  assert.ok(
    groupAdmits(
      group,
      entry("io.github.acme-inc/internal-tools", "Internal tools"),
    ),
  );
  assert.ok(
    groupAdmits(
      group,
      entry("io.github.someone/fork", "Fork", {
        repoUrl: "https://github.com/acme-inc/fork",
      }),
    ),
  );
  // Either the namespace account or the declared repository's owner counts.
  assert.ok(
    groupAdmits(
      group,
      entry("io.github.other/x", "x", {
        repoUrl: "https://github.com/acme-inc/x",
      }),
    ),
  );
  assert.equal(
    groupAdmits(
      group,
      entry("io.github.other/x", "x", {
        repoUrl: "https://github.com/other/acme-inc",
      }),
    ),
    false,
  );
  // A repository elsewhere, or none: no owner to share.
  assert.equal(
    groupAdmits(
      group,
      entry("com.other/tools", "Tools", {
        repoUrl: "https://gitlab.com/acme-inc/tools",
      }),
    ),
    false,
  );
  // Without a declared repository the official server joins nobody by owner.
  const notion = productGroupOf(NOTION_OFFICIAL)!;
  assert.equal(
    groupAdmits(notion, entry("io.github.makenotion/tools", "Tools")),
    false,
  );
});

test("a server two groups admit belongs to one, and both pages agree on it", () => {
  const notion = NOTION_OFFICIAL;
  const smithery = official("ai.smithery/mcp", "Smithery", "smithery.ai", {
    repoUrl: "https://github.com/smithery-ai/mcp-servers",
  });
  const slack = official("com.slack/mcp", "Slack", "slack.com");
  const officials = [smithery, notion, slack];
  const notionGroup = productGroupOf(notion)!;
  const smitheryGroup = productGroupOf(smithery)!;

  // Hosted on Smithery (publisher domain, repository owner and the brand all
  // say so), but a Notion integration: the slug's head names the product.
  const smitheryNotion = NOTION_INTEGRATIONS[0]!;
  assert.ok(groupAdmits(smitheryGroup, smitheryNotion));
  assert.ok(groupAdmits(notionGroup, smitheryNotion));
  assert.equal(
    productGroupFor(smitheryNotion, officials)?.domain,
    "notion.com",
  );
  assert.ok(isProductGroupMember(notionGroup, smitheryNotion, officials));
  assert.equal(
    isProductGroupMember(smitheryGroup, smitheryNotion, officials),
    false,
  );
  // The same whatever order the officials come in.
  assert.equal(
    productGroupFor(smitheryNotion, [notion, slack, smithery])?.domain,
    "notion.com",
  );

  // A compound slug: the last brand named is the product.
  const bridge = entry(
    "io.github.o/notion-slack-bridge",
    "Notion Slack Bridge",
  );
  assert.equal(productGroupFor(bridge, officials)?.domain, "slack.com");
  assert.equal(isProductGroupMember(notionGroup, bridge, officials), false);
  const reverse = entry("io.github.o/slack-notion-sync", "Slack Notion Sync");
  assert.equal(productGroupFor(reverse, officials)?.domain, "notion.com");

  // Only the hosting platform's brand, or only its repository owner: Smithery's.
  assert.equal(
    productGroupFor(
      entry("ai.smithery/smithery-cli", "Smithery CLI"),
      officials,
    )?.domain,
    "smithery.ai",
  );
  assert.equal(
    productGroupFor(
      entry("io.github.smithery-ai/helper", "Helper", {
        publisher: null,
      }),
      officials,
    )?.domain,
    "smithery.ai",
  );
  // Published under a domain without naming any brand: that domain's group.
  assert.equal(
    productGroupFor(
      entry("com.notion/sdk-bridge", "SDK bridge", {
        publisher: publisher("notion.com", false),
      }),
      officials,
    )?.domain,
    "notion.com",
  );
  // Published under one domain, naming another product: the product's group.
  assert.equal(
    productGroupFor(
      entry("com.notion/slack-sync", "Slack sync", {
        publisher: publisher("notion.com", false),
      }),
      officials,
    )?.domain,
    "slack.com",
  );
});

test("brand position is the last whole-token mention across name and tail", () => {
  const notion = productGroupOf(NOTION_OFFICIAL)!;
  assert.equal(
    brandPosition(notion, {
      identifier: "io.github.o/x",
      name: "Smithery Notion",
    }),
    1,
  );
  assert.equal(
    brandPosition(notion, {
      identifier: "io.github.o/notion-sync",
      name: "Sync",
    }),
    1,
  );
  assert.equal(
    brandPosition(notion, { identifier: "io.github.o/x", name: "Other" }),
    -1,
  );
});

test("an official server belongs to its own group even when its slug names another", () => {
  const notion = NOTION_OFFICIAL;
  const other = official(
    "com.example-notes/notion-sync",
    "Notion Sync",
    "example-notes.com",
  );
  assert.equal(
    productGroupFor(other, [notion, other])?.domain,
    "example-notes.com",
  );
  // Two servers on one domain: the older anchors, the newer is a member of it.
  const second = official("com.notion/mcp-sse", "Notion SSE", "notion.com", {
    publishedAt: new Date("2026-10-01T00:00:00Z"),
  });
  const groups = productGroupsOf([second, notion]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.officialIdentifier, "com.notion/mcp");
  assert.equal(
    productGroupFor(second, [second, notion])?.officialIdentifier,
    "com.notion/mcp",
  );
  // An official server whose brand is unusable has no group at all.
  const generic = official("ai.mcp/server", "MCP", "mcp.ai");
  assert.equal(productGroupFor(generic, [generic, notion]), null);
});

test("members order official first, then newest publication, then id", () => {
  const group = productGroupOf(NOTION_OFFICIAL)!;
  const older = entry("io.github.a/notion-a", "A", {
    id: "id-a",
    publishedAt: new Date("2026-09-01T00:00:00Z"),
  });
  const newer = entry("io.github.b/notion-b", "B", {
    id: "id-b",
    publishedAt: new Date("2026-09-10T00:00:00Z"),
  });
  const sameDayLowId = entry("io.github.c/notion-c", "C", {
    id: "id-0",
    publishedAt: new Date("2026-09-10T00:00:00Z"),
  });
  const unpublished = entry("io.github.d/notion-d", "D", {
    id: "id-d",
    publishedAt: null,
  });
  const secondOfficial = official("com.notion/mcp-sse", "SSE", "notion.com", {
    id: "id-s",
    publishedAt: new Date("2026-10-01T00:00:00Z"),
  });
  const ordered = [
    unpublished,
    sameDayLowId,
    older,
    secondOfficial,
    newer,
    NOTION_OFFICIAL,
  ].sort(compareProductGroupMembers(group));
  assert.deepEqual(
    ordered.map((member) => member.identifier),
    [
      "com.notion/mcp",
      "com.notion/mcp-sse",
      "io.github.b/notion-b",
      "io.github.c/notion-c",
      "io.github.a/notion-a",
      "io.github.d/notion-d",
    ],
  );
});

test("no official server, no group", () => {
  assert.deepEqual(productGroupsOf([]), []);
  assert.equal(productGroupFor(NOTION_INTEGRATIONS[0]!, []), null);
  assert.equal(
    productGroupFor(NOTION_INTEGRATIONS[0]!, SUMMARY_ONLY_MENTIONS),
    null,
  );
});
