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
  session: { user: { id: "u1" } } as { user: { id: string } } | null,
  members: [{ userId: "u1", role: "admin" }] as Array<{
    userId: string;
    role: string;
  }>,
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
  useSession: () => ({ data: state.session, isPending: false }),
}));

vi.mock("@better-auth-ui/react/plugins/organization", () => ({
  useActiveOrganization: () => ({ data: state.activeOrg, isPending: false }),
  useListOrganizationMembers: () => ({
    data: { members: state.members },
    isPending: false,
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
    spMetadataUrl:
      "https://api.test/api/auth/sso/saml2/sp/metadata?providerId=acme-com-oidc",
    ...overrides,
  };
}

function render() {
  return mount(
    createElement(OrganizationSso, {
      organizationId: "org1",
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
  state.session = { user: { id: "u1" } };
  state.members = [{ userId: "u1", role: "admin" }];
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
  state.members = [{ userId: "u1", role: "member" }];
  const { container } = await render();
  await flush();

  assert(container.textContent?.includes("orgNoPermission"));
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

test("the service-provider panel shows the endpoint URLs for the real api base and slug", async () => {
  state.providers.mockResolvedValue({
    data: { providers: [oidcProvider({ domainVerified: true })] },
  });
  const { container } = await render();
  await flush();

  const details = button("orgDetails", container);
  if (details) {
    details.click();
    await flush();
  }

  const text = container.textContent ?? "";
  assert(text.includes("https://api.test/api/auth/sso/callback"));
  assert(
    text.includes(
      "https://api.test/api/auth/sso/saml2/sp/acs/acme-com-oidc",
    ),
  );
  assert(
    text.includes(
      "https://api.test/api/auth/sso/saml2/sp/metadata?providerId=acme-com-oidc",
    ),
  );
  assert(text.includes("https://app.test/auth/sso?org=acme"));
});
