// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { McpClaimOverview } from "@sourceweft/contracts";

import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";

const api = vi.hoisted(() => ({
  clearMcpOwnerTools: vi.fn(),
  revokeMcpClaim: vi.fn(),
  setMcpOwnerOverrides: vi.fn(),
}));
vi.mock("../../../../../lib/mcp-claims", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../lib/mcp-claims")>();
  return { ...api, mcpClaimErrorMessage: actual.mcpClaimErrorMessage };
});
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() },
}));

import { toast } from "sonner";
import { McpOwnerPanel } from "./mcp-owner-panel";

const IDENTIFIER = "com.example/server";

function overview(patch: Partial<McpClaimOverview> = {}): McpClaimOverview {
  return {
    identifier: IDENTIFIER,
    name: "Example",
    claimed: true,
    claimedByYou: true,
    blocked: false,
    viewerClaims: [
      {
        id: "claim-1",
        identifier: IDENTIFIER,
        method: "github",
        status: "verified",
        target: "example",
        createdAt: "2026-10-20T00:00:00.000Z",
        expiresAt: null,
        verifiedAt: "2026-10-20T00:00:00.000Z",
        revokedAt: null,
        lastError: null,
      },
    ],
    methods: {
      github: { available: true, owner: "example", reason: null },
      domain: { available: false, domain: null },
    },
    overrides: {
      identifier: IDENTIFIER,
      values: {
        iconUrl: "https://example.com/logo.png",
        summary: "Old summary",
        description: null,
        documentationUrl: "https://docs.example.com",
        homepageUrl: null,
        repoUrl: null,
        deprecated: false,
      },
      tools: null,
      updatedAt: "2026-10-20T00:00:00.000Z",
    },
    ...patch,
  };
}

let container: HTMLDivElement;
const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onChanged.mockResolvedValue(undefined);
  // The Switch measures its thumb; jsdom has no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(unmountAll);

async function render(value: McpClaimOverview) {
  ({ container } = await mountWithIntl(
    <McpOwnerPanel onChanged={onChanged} overview={value} />,
  ));
}

function field(id: string) {
  return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#mcp-owner-${id}`,
  )!;
}

test("saves the whole set, null for every emptied field", async () => {
  api.setMcpOwnerOverrides.mockResolvedValue({});
  await render(overview());
  expect(field("iconUrl").value).toBe("https://example.com/logo.png");
  expect(field("summary").value).toBe("Old summary");

  typeInto(field("iconUrl"), "");
  typeInto(field("summary"), "  New summary ");
  typeInto(field("description"), "A longer text.");
  typeInto(field("license"), "Apache-2.0");
  typeInto(field("language"), " ");
  typeInto(field("repoUrl"), "https://github.com/o/r");
  await click(button("Save"));

  expect(api.setMcpOwnerOverrides).toHaveBeenCalledWith(IDENTIFIER, {
    iconUrl: null,
    summary: "New summary",
    description: "A longer text.",
    license: "Apache-2.0",
    language: null,
    documentationUrl: "https://docs.example.com",
    homepageUrl: null,
    repoUrl: "https://github.com/o/r",
    deprecated: false,
  });
  expect(toast.success).toHaveBeenCalledWith("Listing saved.");
  expect(onChanged).toHaveBeenCalled();
});

test("sends the deprecation switch and refuses a malformed URL", async () => {
  api.setMcpOwnerOverrides.mockResolvedValue({});
  await render(overview());
  await click(container.querySelector<HTMLElement>("#mcp-owner-deprecated")!);
  typeInto(field("homepageUrl"), "not a url");
  await click(button("Save"));
  expect(api.setMcpOwnerOverrides).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    "Enter a full URL starting with https://.",
  );

  typeInto(field("homepageUrl"), "https://example.com");
  await click(button("Save"));
  expect(api.setMcpOwnerOverrides).toHaveBeenCalledWith(
    IDENTIFIER,
    expect.objectContaining({
      deprecated: true,
      homepageUrl: "https://example.com",
    }),
  );
});

test("shows the CLI commands and no removal when no tool list was submitted", async () => {
  await render(overview());
  const tools = container.querySelector('[data-testid="mcp-owner-tools"]')!;
  expect(tools.textContent).toContain("No owner-submitted tool list.");
  expect(tools.textContent).toContain("credentials never reach SourceWeft");
  expect(tools.textContent).toContain(
    `sourceweft mcp submit-tools ${IDENTIFIER} mcp-tools.json --api-key <key>`,
  );
  expect(tools.textContent).not.toContain("Remove tool list");
});

test("removes a submitted tool list after confirmation", async () => {
  api.clearMcpOwnerTools.mockResolvedValue({});
  await render(
    overview({
      overrides: {
        ...overview().overrides!,
        tools: { count: 12, submittedAt: "2026-10-21T10:00:00.000Z" },
      },
    }),
  );
  const tools = container.querySelector('[data-testid="mcp-owner-tools"]')!;
  expect(tools.textContent).toContain("12 tools submitted");
  await click(button("Remove tool list"));
  await flush();
  expect(document.body.textContent).toContain(
    "Remove the submitted tool list?",
  );
  await click(button("Remove", document.body));
  expect(api.clearMcpOwnerTools).toHaveBeenCalledWith(IDENTIFIER);
  expect(toast.success).toHaveBeenCalledWith("Tool list removed.");
});

test("gives the claim up on the verified claim's id after confirmation", async () => {
  api.revokeMcpClaim.mockResolvedValue({});
  await render(overview());
  await click(button("Give up claim"));
  await flush();
  expect(document.body.textContent).toContain(
    "Give up your claim on this server?",
  );
  expect(document.body.textContent).toContain("comes off Example");
  // The confirm button carries the same label as the opener; it is the last.
  const confirms = [...document.body.querySelectorAll("button")].filter(
    (node) => node.textContent?.trim() === "Give up claim",
  );
  await click(confirms[confirms.length - 1]!);
  expect(api.revokeMcpClaim).toHaveBeenCalledWith("claim-1");
  expect(toast.success).toHaveBeenCalledWith("Claim given up.");
  expect(onChanged).toHaveBeenCalled();
});

test("reports a failed save in the page's words", async () => {
  api.setMcpOwnerOverrides.mockRejectedValue({
    code: "MCP_CLAIM_REQUIRED",
    status: 403,
  });
  await render(overview());
  await click(button("Save"));
  expect(toast.error).toHaveBeenCalledWith(
    "Only a verified owner of this server can do this.",
  );
});
