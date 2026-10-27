// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { McpClaim, McpClaimOverview } from "@sourceweft/contracts";

import { button, click, mountWithIntl, unmountAll } from "@/test/react";

const api = vi.hoisted(() => ({
  mcpClaimErrorMessage: vi.fn(),
  startMcpClaim: vi.fn(),
  verifyMcpClaim: vi.fn(),
}));
const auth = vi.hoisted(() => ({ linkSocial: vi.fn() }));
vi.mock("../../../../../lib/mcp-claims", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../lib/mcp-claims")>();
  return {
    ...api,
    // The real mapping, so the page's wording is what is asserted.
    mcpClaimErrorMessage: actual.mcpClaimErrorMessage,
  };
});
vi.mock("../../../../../lib/auth-client", () => ({ authClient: auth }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() },
}));

import { toast } from "sonner";
import { McpClaimFlow } from "./mcp-claim-flow";

const IDENTIFIER = "com.example/server";
// Relative to now, so the fixture claims never expire out from under the tests.
const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function claim(patch: Partial<McpClaim> = {}): McpClaim {
  return {
    id: "claim-1",
    identifier: IDENTIFIER,
    method: "dns_txt",
    status: "pending",
    target: "example.com",
    createdAt: "2026-10-20T00:00:00.000Z",
    expiresAt: IN_A_WEEK,
    verifiedAt: null,
    revokedAt: null,
    lastError: null,
    ...patch,
  };
}

function overview(patch: Partial<McpClaimOverview> = {}): McpClaimOverview {
  return {
    identifier: IDENTIFIER,
    name: "Example",
    claimed: false,
    claimedByYou: false,
    blocked: false,
    viewerClaims: [],
    methods: {
      github: { available: true, owner: "example", reason: null },
      domain: { available: true, domain: "example.com" },
    },
    overrides: null,
    ...patch,
  };
}

const instructions = {
  token: "swc_abc",
  domain: "example.com",
  dnsRecordName: "_sourceweft-claim.example.com",
  dnsRecordValue: "sourceweft-claim=swc_abc",
  wellKnownUrl: "https://example.com/.well-known/sourceweft-claim",
  wellKnownBody: "swc_abc",
  expiresAt: IN_A_WEEK,
};

let container: HTMLDivElement;
const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onChanged.mockResolvedValue(undefined);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "https://app.example/dashboard/mcp/claim?identifier=x" },
  });
});
afterEach(unmountAll);

async function render(value: McpClaimOverview) {
  ({ container } = await mountWithIntl(
    <McpClaimFlow onChanged={onChanged} overview={value} />,
  ));
}

test("claims with the linked GitHub account at once", async () => {
  api.startMcpClaim.mockResolvedValue({
    claim: claim({ method: "github", status: "verified" }),
    instructions: null,
  });
  await render(overview());
  expect(container.textContent).toContain(
    "Published under GitHub account example.",
  );
  await click(button("Claim with GitHub account"));
  expect(api.startMcpClaim).toHaveBeenCalledWith(IDENTIFIER, {
    method: "github",
  });
  expect(toast.success).toHaveBeenCalledWith(
    "Server claimed. Its listing is now yours to manage.",
  );
  expect(onChanged).toHaveBeenCalled();
});

test("offers to link GitHub when no account is linked, back to this page", async () => {
  await render(
    overview({
      methods: {
        github: { available: false, owner: "example", reason: "not_linked" },
        domain: { available: false, domain: null },
      },
    }),
  );
  expect(container.textContent).toContain(
    "Link the GitHub account that publishes this server first.",
  );
  expect(container.querySelector('[data-testid="mcp-claim-domain"]')).toBeNull();
  await click(button("Link GitHub account"));
  expect(auth.linkSocial).toHaveBeenCalledWith({
    provider: "github",
    callbackURL: "https://app.example/dashboard/mcp/claim?identifier=x",
  });
});

test("asks for read:org when the organization role cannot be read", async () => {
  api.startMcpClaim.mockRejectedValue({
    code: "MCP_CLAIM_GITHUB_ORG_SCOPE",
    status: 403,
  });
  await render(overview());
  await click(button("Claim with GitHub account"));
  expect(container.textContent).toContain(
    "Grant organization read access and try again.",
  );
  await click(button("Grant organization read access"));
  expect(auth.linkSocial).toHaveBeenCalledWith({
    provider: "github",
    callbackURL: "https://app.example/dashboard/mcp/claim?identifier=x",
    scopes: ["read:org"],
  });
});

test("hides both cards when the entry is neither GitHub nor domain published", async () => {
  await render(
    overview({
      methods: {
        github: { available: false, owner: null, reason: "not_github_entry" },
        domain: { available: false, domain: null },
      },
    }),
  );
  expect(container.textContent).toContain("cannot be claimed here yet");
  expect(container.querySelector("button")).toBeNull();
});

test("starts a DNS claim, shows the one-time instructions and verifies", async () => {
  api.startMcpClaim.mockResolvedValue({ claim: claim(), instructions });
  api.verifyMcpClaim.mockResolvedValue({
    claim: claim({ status: "verified", verifiedAt: "2026-10-21T00:00:00.000Z" }),
  });
  await render(overview());
  await click(button("DNS TXT record"));
  expect(api.startMcpClaim).toHaveBeenCalledWith(IDENTIFIER, {
    method: "dns_txt",
  });
  const card = container.querySelector(
    '[data-testid="mcp-claim-instructions"]',
  )!;
  expect(card.textContent).toContain("shown only this once");
  expect(card.textContent).toContain("_sourceweft-claim.example.com");
  expect(card.textContent).toContain("sourceweft-claim=swc_abc");
  expect(card.textContent).not.toContain(".well-known");
  expect(card.textContent).toContain("Valid until");

  await click(button("Verify now"));
  expect(api.verifyMcpClaim).toHaveBeenCalledWith("claim-1");
  expect(toast.success).toHaveBeenCalledWith(
    "Server claimed. Its listing is now yours to manage.",
  );
  expect(
    container.querySelector('[data-testid="mcp-claim-instructions"]'),
  ).toBeNull();
});

test("shows the well-known URL and exact body for that method", async () => {
  api.startMcpClaim.mockResolvedValue({
    claim: claim({ method: "well_known" }),
    instructions,
  });
  await render(overview());
  await click(button("Well-known file"));
  const card = container.querySelector(
    '[data-testid="mcp-claim-instructions"]',
  )!;
  expect(card.textContent).toContain(
    "https://example.com/.well-known/sourceweft-claim",
  );
  expect(card.textContent).toContain("Exact body");
  expect(card.textContent).not.toContain("Record name");
});

test("explains a token that was not found and keeps the claim verifiable", async () => {
  api.verifyMcpClaim.mockRejectedValue({
    code: "MCP_CLAIM_TOKEN_NOT_FOUND",
    status: 409,
  });
  await render(
    overview({
      viewerClaims: [claim({ lastError: "no TXT record" })],
    }),
  );
  const list = container.querySelector('[data-testid="mcp-claim-list"]')!;
  expect(list.textContent).toContain("Pending");
  expect(list.textContent).toContain("Last attempt: no TXT record");
  expect(list.textContent).toContain("cannot be shown again");
  expect(list.textContent).toContain("Expires");

  await click(button("Verify"));
  expect(api.verifyMcpClaim).toHaveBeenCalledWith("claim-1");
  expect(container.textContent).toContain(
    "DNS changes can take time to propagate",
  );
  expect(onChanged).toHaveBeenCalled();
});

test("shows a rate-limited verify as a wait-and-retry message", async () => {
  api.verifyMcpClaim.mockRejectedValue({
    code: "MCP_CLAIM_RATE_LIMITED",
    status: 429,
  });
  await render(overview({ viewerClaims: [claim()] }));
  await click(button("Verify"));
  expect(container.textContent).toContain(
    "Too many attempts. Wait a little and try again.",
  );
  expect(onChanged).toHaveBeenCalled();
});

test("replaces the whole flow with a notice for a blocked viewer", async () => {
  await render(
    overview({
      blocked: true,
      // Even a lingering pending claim offers no action.
      viewerClaims: [claim()],
    }),
  );
  const notice = container.querySelector('[data-testid="mcp-claim-blocked"]')!;
  expect(notice.textContent).toContain(
    "Claiming is closed for you on this server",
  );
  expect(notice.textContent).toContain(
    "A SourceWeft admin blocked your account from claiming this server. If you think that was a mistake, write to support@sourceweft.com.",
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector('[data-testid="mcp-claim-list"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="mcp-claim-domain"]'),
  ).toBeNull();
  expect(container.textContent).not.toContain("Prove you publish this server");
  expect(api.startMcpClaim).not.toHaveBeenCalled();
});

test("offers no Verify for an expired pending claim", async () => {
  await render(
    overview({
      viewerClaims: [claim({ expiresAt: "2020-01-01T00:00:00.000Z" })],
    }),
  );
  const list = container.querySelector('[data-testid="mcp-claim-list"]')!;
  expect(list.textContent).toContain("Expired");
  expect(list.querySelector("button")).toBeNull();
});
