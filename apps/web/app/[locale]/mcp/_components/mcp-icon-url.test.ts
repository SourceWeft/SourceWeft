import { expect, test } from "vitest";

import {
  MCP_ICON_TRUSTED_HOSTS,
  mcpIconMonogram,
  safeMcpIconUrl,
} from "./mcp-icon-url";

test("GitHub avatars render only from github.com and its avatar CDN", () => {
  expect(MCP_ICON_TRUSTED_HOSTS).toEqual([
    "github.com",
    "avatars.githubusercontent.com",
  ]);
  for (const source of ["github-avatar", "github-registry"] as const) {
    expect(safeMcpIconUrl("https://github.com/acme.png?size=128", source)).toBe(
      "https://github.com/acme.png?size=128",
    );
    expect(
      safeMcpIconUrl("https://avatars.githubusercontent.com/u/1?v=4", source),
    ).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(safeMcpIconUrl("https://evil.test/acme.png", source)).toBeNull();
    expect(
      safeMcpIconUrl("https://github.com.evil.test/a.png", source),
    ).toBeNull();
  }
});

test("registry, server-info and stored favicon icons need only a credential-free https URL", () => {
  expect(safeMcpIconUrl("https://cdn.acme.test/icon.png", "registry")).toBe(
    "https://cdn.acme.test/icon.png",
  );
  expect(
    safeMcpIconUrl(
      "https://assets.sourceweft.com/market/mcp-icons/notion.com/a.png",
      "favicon",
    ),
  ).toBe("https://assets.sourceweft.com/market/mcp-icons/notion.com/a.png");
  expect(safeMcpIconUrl("https://cdn.acme.test/icon.png")).toBe(
    "https://cdn.acme.test/icon.png",
  );
  expect(
    safeMcpIconUrl("http://cdn.acme.test/icon.png", "registry"),
  ).toBeNull();
  expect(safeMcpIconUrl("https://u:p@cdn.acme.test/icon.png")).toBeNull();
  expect(safeMcpIconUrl("javascript:alert(1)")).toBeNull();
  expect(safeMcpIconUrl("not a url")).toBeNull();
  expect(safeMcpIconUrl(null, "placeholder")).toBeNull();
  expect(safeMcpIconUrl("")).toBeNull();
});

test("the monogram is the first letter or digit, uppercased, in any script", () => {
  expect(mcpIconMonogram("Notion")).toBe("N");
  expect(mcpIconMonogram("  acme labs")).toBe("A");
  expect(mcpIconMonogram("1Password")).toBe("1");
  expect(mcpIconMonogram("@scope/pkg")).toBe("S");
  expect(mcpIconMonogram("飞书 MCP")).toBe("飞");
  expect(mcpIconMonogram("---")).toBeNull();
  expect(mcpIconMonogram("")).toBeNull();
  expect(mcpIconMonogram(null)).toBeNull();
});
