// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const GENERIC_ERROR = "Something went wrong. Please try again.";

// Every `localization.<key>` resolves to the key itself, so assertions can key
// off the identifier instead of the (separately tested) English copy.
const localization = new Proxy(
  {},
  { get: (_target, key) => (typeof key === "string" ? key : "") },
) as Record<string, string>;

const state = vi.hoisted(() => ({
  providers: vi.fn(),
  register: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  requestDomainVerification: vi.fn(),
  verifyDomain: vi.fn(),
  // The caller's own role, resolved by `useActiveMemberRole` (not by scanning a
  // paginated member list — the member list is deliberately not even mocked).
  memberRole: { role: "admin" } as { role: string } | undefined,
  rolePending: false,
  activeOrg: {
    id: "org1",
    slug: "acme",
    metadata: { sourceweft: { kind: "team" } },
  } as { id: string; slug: string; metadata: unknown },
}));

vi.mock("@/lib/auth/sso-plugin", () => ({ ssoPlugin: { id: "sso" } }));

vi.mock("@/lib/api-base-url", () => ({ apiBaseUrl: "https://api.test" }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({
    authClient: {
      sso: {
        providers: state.providers,
        register: state.register,
        updateProvider: state.updateProvider,
        deleteProvider: state.deleteProvider,
        requestDomainVerification: state.requestDomainVerification,
        verifyDomain: state.verifyDomain,
      },
    },
    baseURL: "https://app.test",
    localization: { errors: { generic: GENERIC_ERROR } },
  }),
  useAuthPlugin: () => ({ localization }),
}));

vi.mock("@better-auth-ui/react/plugins/organization", () => ({
  useActiveOrganization: () => ({ data: state.activeOrg, isPending: false }),
  useActiveMemberRole: () => ({
    data: state.memberRole,
    isPending: state.rolePending,
  }),
}));

import { OrganizationSso } from "./organization-sso";
import { button, buttons, flush, mount, unmountAll } from "@/test/react";

function oidcProvider(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "acme-com-oidc",
    type: "oidc",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    organizationId: "org1",
    domainVerified: false,
    oidcConfig: {
      discoveryEndpoint: "https://idp.acme.com/.well-known/openid-configuration",
      clientIdLastFour: "4321",
      pkce: true,
      scopes: ["openid", "email", "profile"],
    },
    ...overrides,
  };
}

function samlProvider(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "acme-com-saml",
    type: "saml",
    issuer:
      "https://api.test/api/auth/sso/saml2/sp/metadata?providerId=acme-com-saml",
    domain: "acme.com",
    organizationId: "org1",
    domainVerified: true,
    samlConfig: { entryPoint: "https://idp.acme.com/sso" },
    ...overrides,
  };
}

function render(organizationId = "org1") {
  return mount(
    createElement(OrganizationSso, {
      organizationId,
      organizationSlug: "acme",
    }),
  );
}

beforeEach(() => {
  for (const fn of [
    state.providers,
    state.register,
    state.updateProvider,
    state.deleteProvider,
    state.requestDomainVerification,
    state.verifyDomain,
  ]) {
    fn.mockReset();
  }
  state.memberRole = { role: "admin" };
  state.rolePending = false;
  state.activeOrg = {
    id: "org1",
    slug: "acme",
    metadata: { sourceweft: { kind: "team" } },
  };
  state.providers.mockResolvedValue({ data: { providers: [] } });
});

afterEach(async () => {
  await unmountAll();
});

test("a plain member sees the no-permission notice and no provider request", async () => {
  state.memberRole = { role: "member" };
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgNoPermission"));
  assert.equal(state.providers.mock.calls.length, 0);
});

// W2 — admin detection comes from the active-member-role endpoint, which
// resolves the caller's role even when they are off the first page of members
// (the member list is not mocked at all, so any attempt to scan it would fail).
test("an owner whose role the active-member-role hook returns can manage", async () => {
  state.memberRole = { role: "owner" };
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgEmptyTitle"));
  assert.equal(state.providers.mock.calls.length, 1);
});

test("no provider request is made until the role gate resolves", async () => {
  state.memberRole = undefined;
  state.rolePending = true;
  const { container } = await render();
  await flush();

  assert(!container.textContent?.includes("orgEmptyTitle"));
  assert.equal(state.providers.mock.calls.length, 0);
});

test("a personal workspace shows the teams-only notice and no request", async () => {
  state.activeOrg = {
    id: "org1",
    slug: "acme",
    metadata: { sourceweft: { kind: "personal" } },
  };
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgTeamsOnly"));
  assert.equal(state.providers.mock.calls.length, 0);
});

test("an admin with no providers sees the empty state and an enabled add button", async () => {
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgEmptyTitle"));
  const add = button("orgAddProvider", container);
  assert(add, "the add button is rendered");
  assert(!add.disabled, "the add button is enabled below the limit");
  assert.equal(state.providers.mock.calls.length, 1);
});

// W1 — providers of another organization the caller admins must not appear or
// count toward this organization's 5-provider cap.
test("a foreign-organization provider is not rendered and does not count toward the cap", async () => {
  state.providers.mockResolvedValue({
    data: {
      providers: [
        ...Array.from({ length: 4 }, (_, index) =>
          oidcProvider({ providerId: `org1-${index}`, domainVerified: true }),
        ),
        oidcProvider({
          providerId: "other-team-provider",
          organizationId: "org2",
          domainVerified: true,
        }),
        oidcProvider({
          providerId: "other-team-provider-2",
          organizationId: "org2",
          domainVerified: true,
        }),
      ],
    },
  });
  const { container } = await render("org1");
  await flush();

  assert(
    !container.textContent?.includes("other-team-provider"),
    "a provider from org2 is not rendered in org1's tab",
  );
  const add = button("orgAddProvider", container);
  assert(
    !add.disabled,
    "four own providers are below the cap even with two foreign ones present",
  );
});

// W1 — a stale response for a previous organization must not overwrite the list.
test("switching organization ignores a late response for the previous one", async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  let resolveSecond: (value: unknown) => void = () => {};
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  state.providers.mockReturnValueOnce(first).mockReturnValueOnce(second);

  const mounted = await render("org1");
  await flush();
  await mounted.render(
    createElement(OrganizationSso, {
      organizationId: "org2",
      organizationSlug: "acme",
    }),
  );
  await flush();

  // The newer (org2) request resolves first, then the stale (org1) one.
  resolveSecond({
    data: { providers: [oidcProvider({ providerId: "org2-only", organizationId: "org2" })] },
  });
  await flush(2);
  resolveFirst({
    data: { providers: [oidcProvider({ providerId: "org1-only", organizationId: "org1" })] },
  });
  await flush(2);

  assert(
    mounted.container.textContent?.includes("org2-only"),
    "the current organization's providers are shown",
  );
  assert(
    !mounted.container.textContent?.includes("org1-only"),
    "the stale response for the previous organization is ignored",
  );
});

// W9 — the direct sign-in link appears once, only with exactly one verified
// provider; otherwise a one-line explanation is shown.
test("one verified provider shows the direct sign-in link once", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: true })] },
  });
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgDirectSignInLink"));
  assert(container.textContent?.includes("https://app.test/auth/sso?org=acme"));
});

test("several verified providers show the explanation, not a link", async () => {
  state.providers.mockResolvedValue({
    data: {
      providers: [
        oidcProvider({ providerId: "p1", domainVerified: true }),
        oidcProvider({ providerId: "p2", domainVerified: true }),
      ],
    },
  });
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgDirectSignInMany"));
  assert(
    !container.textContent?.includes("https://app.test/auth/sso?org=acme"),
    "no ambiguous direct link with several providers",
  );
});

test("no verified provider shows the pending explanation", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: false })] },
  });
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgDirectSignInNone"));
});

test("a pending provider shows the pending status and a verify entry", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: false })] },
  });
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgStatusPending"));
  assert(
    buttons("orgVerify", container).length > 0 ||
      container.textContent?.includes("orgDomainVerification"),
    "a path into domain verification is offered",
  );
});

test("a verified provider shows the verified status", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: true })] },
  });
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgStatusVerified"));
  assert(!container.textContent?.includes("orgStatusPending"));
});

test("the add button is disabled once five providers exist", async () => {
  state.providers.mockResolvedValue({
    data: {
      providers: Array.from({ length: 5 }, (_, index) =>
        oidcProvider({ providerId: `p-${index}`, domainVerified: true }),
      ),
    },
  });
  const { container } = await render();
  await flush();

  const add = button("orgAddProvider", container);
  assert(add.disabled, "the add button is disabled at the per-team limit");
  assert(container.textContent?.includes("orgProviderLimitReached"));
});

test("deleting a provider calls deleteProvider with its id and refreshes the list", async () => {
  state.providers
    .mockResolvedValueOnce({ data: { providers: [oidcProvider()] } })
    .mockResolvedValueOnce({ data: { providers: [] } });
  state.deleteProvider.mockResolvedValue({ data: null });

  const { container } = await render();
  await flush();

  button("orgDelete", container).click();
  await flush();

  // The confirm button lives in the AlertDialog portal (document.body), not
  // inside the mounted container.
  button("orgDeleteConfirm").click();
  await flush(3);

  assert.equal(state.deleteProvider.mock.calls.length, 1);
  assert.deepEqual(state.deleteProvider.mock.calls[0]?.[0], {
    providerId: "acme-com-oidc",
  });
  assert.equal(
    state.providers.mock.calls.length,
    2,
    "the list is refetched after deletion",
  );
});

test("verifying a domain flips the row to verified", async () => {
  state.providers
    .mockResolvedValueOnce({
      data: { providers: [oidcProvider({ domainVerified: false })] },
    })
    .mockResolvedValue({
      data: { providers: [oidcProvider({ domainVerified: true })] },
    });
  state.requestDomainVerification.mockResolvedValue({
    data: { domainVerificationToken: "tok-123" },
  });
  state.verifyDomain.mockResolvedValue({ data: null });

  const { container } = await render();
  await flush();

  button("orgVerify", container).click();
  await flush(4);

  assert.equal(state.verifyDomain.mock.calls.length, 1);
  assert.deepEqual(state.verifyDomain.mock.calls[0]?.[0], {
    providerId: "acme-com-oidc",
  });
  assert(container.textContent?.includes("orgStatusVerified"));
});

// W6 — the plugin's English DOMAIN_VERIFICATION_FAILED is mapped to localized copy.
test("a DNS-not-found verification error is shown as localized copy, not English", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: false })] },
  });
  state.requestDomainVerification.mockResolvedValue({
    data: { domainVerificationToken: "tok-123" },
  });
  state.verifyDomain.mockResolvedValue({
    error: {
      status: 502,
      code: "DOMAIN_VERIFICATION_FAILED",
      message: "Unable to verify domain ownership due to server error",
    },
  });

  const { container } = await render();
  await flush();

  button("orgVerify", container).click();
  await flush(4);

  assert(container.textContent?.includes("orgErrDomainVerificationFailed"));
  assert(
    !container.textContent?.includes("server error"),
    "the raw English plugin message is never shown",
  );
});

// W6 — DOMAIN_VERIFIED (already verified) is treated as success and refreshes.
test("an already-verified response during verify is treated as success", async () => {
  state.providers
    .mockResolvedValueOnce({
      data: { providers: [oidcProvider({ domainVerified: false })] },
    })
    .mockResolvedValue({
      data: { providers: [oidcProvider({ domainVerified: true })] },
    });
  state.requestDomainVerification.mockResolvedValue({
    data: { domainVerificationToken: "tok-123" },
  });
  state.verifyDomain.mockResolvedValue({
    error: { status: 409, code: "DOMAIN_VERIFIED", message: "Domain has already been verified" },
  });

  const { container } = await render();
  await flush();

  button("orgVerify", container).click();
  await flush(4);

  assert(container.textContent?.includes("orgStatusVerified"));
  assert(
    !container.textContent?.includes("Domain has already been verified"),
    "the already-verified case is a success, not an error",
  );
});

test("a rejected domain verification shows the backend message", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: false })] },
  });
  state.requestDomainVerification.mockResolvedValue({
    data: { domainVerificationToken: "tok-123" },
  });
  state.verifyDomain.mockResolvedValue({
    error: { code: "SSO_DOMAIN_NOT_ALLOWED", message: "域名未获授权。" },
  });

  const { container } = await render();
  await flush();

  button("orgVerify", container).click();
  await flush(4);

  assert(container.textContent?.includes("域名未获授权。"));
});

// The SP panel shows only the rows for the provider's own protocol.
test("the OIDC service-provider panel shows the OIDC redirect URI only", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: true })] },
  });
  const { container } = await render();
  await flush();

  button("orgDetails", container)?.click();
  await flush();

  const text = container.textContent ?? "";
  assert(text.includes("https://api.test/api/auth/sso/callback"));
  assert(
    !text.includes("https://api.test/api/auth/sso/saml2/sp/acs/"),
    "no SAML rows for an OIDC provider",
  );
});

test("the SAML service-provider panel shows the SAML endpoints", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [samlProvider({ domainVerified: true })] },
  });
  const { container } = await render();
  await flush();

  button("orgDetails", container)?.click();
  await flush();

  const text = container.textContent ?? "";
  assert(
    text.includes("https://api.test/api/auth/sso/saml2/sp/acs/acme-com-saml"),
  );
  assert(
    text.includes(
      "https://api.test/api/auth/sso/saml2/sp/metadata?providerId=acme-com-saml",
    ),
  );
  assert(
    !text.includes("https://api.test/api/auth/sso/callback"),
    "no OIDC redirect row for a SAML provider",
  );
});
