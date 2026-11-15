// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const GENERIC_ERROR = "Something went wrong. Please try again.";

const localization = new Proxy(
  {},
  { get: (_target, key) => (typeof key === "string" ? key : "") },
) as Record<string, string>;

const state = vi.hoisted(() => ({
  register: vi.fn(),
  updateProvider: vi.fn(),
  onSaved: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock("@/lib/auth/sso-plugin", () => ({ ssoPlugin: { id: "sso" } }));
vi.mock("@/lib/api-base-url", () => ({ apiBaseUrl: "https://api.test" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({
    authClient: {
      sso: { register: state.register, updateProvider: state.updateProvider },
    },
    baseURL: "https://app.test",
    localization: { errors: { generic: GENERIC_ERROR } },
  }),
  useAuthPlugin: () => ({ localization }),
}));

import {
  SsoProviderDialog,
  type SsoProviderSummary
} from "./sso-provider-dialog";
import { button, flush, mount, typeInto, unmountAll } from "@/test/react";

function field(id: string) {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#${id}`,
  );
}

function renderCreate() {
  return mount(
    createElement(SsoProviderDialog, {
      open: true,
      onOpenChange: state.onOpenChange,
      organizationId: "org1",
      organizationSlug: "acme",
      onSaved: state.onSaved,
    }),
  );
}

function renderEdit(provider: Record<string, unknown>) {
  return mount(
    createElement(SsoProviderDialog, {
      open: true,
      onOpenChange: state.onOpenChange,
      organizationId: "org1",
      organizationSlug: "acme",
      onSaved: state.onSaved,
      provider: provider as unknown as SsoProviderSummary,
    }),
  );
}

function fillOidc(secret = "s3cret") {
  typeInto(field("sso-domain")!, "acme.com");
  typeInto(field("sso-issuer")!, "https://idp.acme.com");
  typeInto(field("sso-client-id")!, "client-xyz");
  if (secret) typeInto(field("sso-client-secret")!, secret);
}

beforeEach(() => {
  state.register.mockReset();
  state.updateProvider.mockReset();
  state.onSaved.mockReset();
  state.onOpenChange.mockReset();
  state.register.mockResolvedValue({ data: {} });
  state.updateProvider.mockResolvedValue({ data: {} });
});

afterEach(async () => {
  await unmountAll();
});

test("suggests a providerId from the domain and protocol", async () => {
  await renderCreate();
  await flush();

  typeInto(field("sso-domain")!, "Acme.com");
  await flush();

  assert.equal(field("sso-provider-id")!.value, "acme-com-oidc");
});

test("an OIDC create without a client secret does not submit", async () => {
  await renderCreate();
  await flush();

  fillOidc("");
  button("orgSave").click();
  await flush();

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgFieldRequired"));
});

test("a successful OIDC create sends the organization id and typed domain", async () => {
  await renderCreate();
  await flush();

  fillOidc();
  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 1);
  const payload = state.register.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.equal(payload.organizationId, "org1");
  assert.equal(payload.domain, "acme.com");
  assert.equal(
    (payload.oidcConfig as Record<string, unknown>).clientSecret,
    "s3cret",
  );
  assert.equal(state.onSaved.mock.calls.length, 1);
});

test("editing with an empty client secret omits clientSecret from the update", async () => {
  await renderEdit({
    providerId: "acme-com-oidc",
    type: "oidc",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    domainVerified: true,
    oidcConfig: {
      discoveryEndpoint: "https://idp.acme.com/.well-known/openid-configuration",
      clientIdLastFour: "4321",
      pkce: true,
      scopes: ["openid", "email", "profile"],
    },
  });
  await flush();

  // Change something harmless so the update is meaningful, leave the secret blank.
  typeInto(field("sso-role-attribute")!, "groups");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.updateProvider.mock.calls.length, 1);
  const payload = state.updateProvider.mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
  assert.equal(payload.providerId, "acme-com-oidc");
  assert(
    !JSON.stringify(payload).includes("clientSecret"),
    "no clientSecret key is sent when the secret field is left blank",
  );
});

test("the providerId cannot be changed while editing", async () => {
  await renderEdit({
    providerId: "acme-com-oidc",
    type: "oidc",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    domainVerified: true,
    oidcConfig: { clientIdLastFour: "4321", pkce: true, scopes: [] },
  });
  await flush();

  const providerId = field("sso-provider-id")!;
  assert.equal(providerId.value, "acme-com-oidc");
  assert(
    providerId.disabled || providerId.readOnly,
    "the providerId field is not editable while editing",
  );
});

// A compact but valid IdP metadata document (Okta-style prefixes).
const SAML_METADATA = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.acme.com/entity">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>ACMESIGNINGCERT==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.com/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

test("pasting SAML metadata fills the explicit fields and submits them (never raw metadata)", async () => {
  await renderCreate();
  await flush();

  button("orgProtocolSaml").click();
  await flush();

  typeInto(field("sso-domain")!, "acme.com");
  await flush();
  typeInto(field("sso-metadata")!, SAML_METADATA);
  await flush();

  // The three explicit fields are filled from the metadata.
  assert.equal(field("sso-entry-point")!.value, "https://idp.acme.com/sso");
  assert.equal(field("sso-idp-entity-id")!.value, "https://idp.acme.com/entity");
  assert.equal(field("sso-cert")!.value, "ACMESIGNINGCERT==");

  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 1);
  const payload = state.register.mock.calls[0]?.[0] as Record<string, unknown>;
  const saml = payload.samlConfig as {
    entryPoint?: unknown;
    cert?: unknown;
    idpMetadata?: { entityID?: unknown; metadata?: unknown };
  };
  // The register body zod schema is NOT exported from `@better-auth/sso`; these
  // shapes are checked against the plugin's `samlConfigSchema`
  // (node_modules/@better-auth/sso/dist/index.mjs ~L1917): `entryPoint:
  // z.string().url()` is REQUIRED, `idpMetadata` is required (metadata|entityID),
  // `cert` optional. A metadata-only body (no entryPoint) is a 400 — the bug this
  // test guards against.
  assert(
    typeof saml.entryPoint === "string" && /^https?:\/\//.test(saml.entryPoint),
    "a valid URL entryPoint is always sent",
  );
  assert.equal(saml.cert, "ACMESIGNINGCERT==");
  assert.equal(saml.idpMetadata?.entityID, "https://idp.acme.com/entity");
  assert(
    !("metadata" in (saml.idpMetadata ?? {})),
    "the raw metadata XML is never submitted",
  );
});

test("a SAML provider can never submit a samlConfig without an entryPoint", async () => {
  await renderCreate();
  await flush();

  button("orgProtocolSaml").click();
  await flush();

  typeInto(field("sso-domain")!, "acme.com");
  // Fill cert + entity id but leave the sign-on URL blank.
  typeInto(field("sso-cert")!, "ACMESIGNINGCERT==");
  typeInto(field("sso-idp-entity-id")!, "https://idp.acme.com/entity");
  await flush();
  button("orgSave").click();
  await flush();

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgFieldRequired"));
});

test("a SAML provider with neither endpoint config nor metadata does not submit", async () => {
  await renderCreate();
  await flush();

  button("orgProtocolSaml").click();
  await flush();

  typeInto(field("sso-domain")!, "acme.com");
  button("orgSave").click();
  await flush();

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgSamlNeedsConfig"));
});

test("a rejected domain shows the backend message in the dialog", async () => {
  state.register.mockResolvedValue({
    error: { code: "SSO_DOMAIN_NOT_ALLOWED", message: "域名不被允许。" },
  });
  await renderCreate();
  await flush();

  fillOidc();
  button("orgSave").click();
  await flush(3);

  assert(document.body.textContent?.includes("域名不被允许。"));
});

test("a 429 shows the localized rate-limit message instead of the raw body", async () => {
  state.register.mockResolvedValue({
    error: { status: 429, message: "Too many requests" },
  });
  await renderCreate();
  await flush();

  fillOidc();
  button("orgSave").click();
  await flush(3);

  assert(document.body.textContent?.includes("orgRateLimited"));
  assert(!document.body.textContent?.includes("Too many requests"));
});
