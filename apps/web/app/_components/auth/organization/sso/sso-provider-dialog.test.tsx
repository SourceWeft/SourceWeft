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
  suggestProviderId,
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
  typeInto(field("sso-domain")!, "acme.io");
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

const SAML_PROVIDER = {
  providerId: "acme-com-saml",
  type: "saml",
  issuer:
    "https://api.test/api/auth/sso/saml2/sp/metadata?providerId=acme-com-saml",
  domain: "acme.com",
  domainVerified: true,
  // A stored entry point that differs from SAML_METADATA's, so a paste-on-edit
  // registers as a real change.
  samlConfig: { entryPoint: "https://old-idp.acme.com/sso" },
  roleAttribute: null,
  adminRoleValue: null,
};

async function editSaml() {
  const mounted = await renderEdit(SAML_PROVIDER);
  await flush();
  return mounted;
}

test("editing a SAML provider and changing only the domain sends no samlConfig", async () => {
  await editSaml();

  assert(field("sso-provider-id")!.disabled, "providerId stays immutable");
  // cert / entity id are blank (never returned) but the edit is not blocked.
  typeInto(field("sso-domain")!, "acme.io");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.updateProvider.mock.calls.length, 1);
  const payload = state.updateProvider.mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
  assert.equal(payload.providerId, "acme-com-saml");
  assert.equal(payload.domain, "acme.io");
  assert(!("samlConfig" in payload), "nothing stored is resent");
});

test("editing the role mapping of a SAML provider sends no samlConfig", async () => {
  await editSaml();

  // Role mapping must be set as a pair (attribute + admin value).
  typeInto(field("sso-role-attribute")!, "groups");
  typeInto(field("sso-admin-role-value")!, "sw-admins");
  button("orgSave").click();
  await flush(3);

  const payload = state.updateProvider.mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
  assert.equal(payload.roleAttribute, "groups");
  assert.equal(payload.adminRoleValue, "sw-admins");
  assert(!("samlConfig" in payload));
});

test("changing only the SAML entry point sends entryPoint and not cert or entity id", async () => {
  await editSaml();

  typeInto(field("sso-entry-point")!, "https://idp.acme.com/sso2");
  button("orgSave").click();
  await flush(3);

  const payload = state.updateProvider.mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
  const saml = payload.samlConfig as Record<string, unknown>;
  assert.equal(saml.entryPoint, "https://idp.acme.com/sso2");
  assert(!("cert" in saml));
  assert(!("idpMetadata" in saml));
});

test("entering only a new certificate on edit sends cert and nothing else", async () => {
  await editSaml();

  typeInto(field("sso-cert")!, "NEWSIGNINGCERT==");
  button("orgSave").click();
  await flush(3);

  const payload = state.updateProvider.mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
  const saml = payload.samlConfig as Record<string, unknown>;
  assert.equal(saml.cert, "NEWSIGNINGCERT==");
  assert(!("entryPoint" in saml), "the unchanged entry point is not resent");
  assert(!("idpMetadata" in saml));
});

test("an invalid entry point URL blocks a SAML edit", async () => {
  await editSaml();

  typeInto(field("sso-entry-point")!, "not-a-url");
  button("orgSave").click();
  await flush();

  assert.equal(state.updateProvider.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgEntryPointInvalid"));
});

test("pasting metadata while editing fills the fields and sends the filled values", async () => {
  await editSaml();

  typeInto(field("sso-metadata")!, SAML_METADATA);
  await flush();
  assert.equal(field("sso-idp-entity-id")!.value, "https://idp.acme.com/entity");

  button("orgSave").click();
  await flush(3);

  const payload = state.updateProvider.mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;
  const saml = payload.samlConfig as {
    entryPoint?: unknown;
    cert?: unknown;
    idpMetadata?: { entityID?: unknown };
  };
  assert.equal(saml.entryPoint, "https://idp.acme.com/sso");
  assert.equal(saml.cert, "ACMESIGNINGCERT==");
  assert.equal(saml.idpMetadata?.entityID, "https://idp.acme.com/entity");
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

// W5 — provider IDs over 47 characters can never be DNS-verified.
test("suggestProviderId never exceeds 47 characters, even from a long domain", () => {
  const longDomain = `${"a".repeat(60)}.example.com`;
  const id = suggestProviderId(longDomain, "oidc");
  assert(id.length <= 47, `expected <= 47 chars, got ${id.length}`);
  assert(id.endsWith("-oidc"), "keeps the protocol suffix");
  assert(!/-$/.test(id.slice(0, -5)), "no trailing hyphen before the suffix");
  assert(/^[a-z0-9-]{3,47}$/.test(id), "matches the allowed provider-id pattern");
});

test("a provider id longer than 47 characters is rejected client-side", async () => {
  await renderCreate();
  await flush();

  typeInto(field("sso-domain")!, "acme.com");
  // Type an over-long id by hand (marks the field as touched so it is kept).
  typeInto(field("sso-provider-id")!, "a".repeat(48));
  fillOidc();
  // fillOidc re-typed the domain; re-assert the long id.
  typeInto(field("sso-provider-id")!, "a".repeat(48));
  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgProviderIdInvalid"));
});

// W4 — role mapping must be filled as a pair.
test("a role attribute without an admin value does not submit", async () => {
  await renderCreate();
  await flush();

  fillOidc();
  typeInto(field("sso-role-attribute")!, "groups");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgRoleMappingIncomplete"));
});

test("an admin value without a role attribute does not submit", async () => {
  await renderCreate();
  await flush();

  fillOidc();
  typeInto(field("sso-admin-role-value")!, "sw-admins");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgRoleMappingIncomplete"));
});

test("both role mapping fields together submit successfully", async () => {
  await renderCreate();
  await flush();

  fillOidc();
  typeInto(field("sso-role-attribute")!, "groups");
  typeInto(field("sso-admin-role-value")!, "sw-admins");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 1);
  const payload = state.register.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.equal(payload.roleAttribute, "groups");
  assert.equal(payload.adminRoleValue, "sw-admins");
});

// W6 — client-side issuer validation.
test("an OIDC issuer that is not an http(s) URL does not submit", async () => {
  await renderCreate();
  await flush();

  typeInto(field("sso-domain")!, "acme.com");
  typeInto(field("sso-issuer")!, "not-a-url");
  typeInto(field("sso-client-id")!, "client-xyz");
  typeInto(field("sso-client-secret")!, "s3cret");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.register.mock.calls.length, 0);
  assert(document.body.textContent?.includes("orgIssuerInvalid"));
});

// W6 — an edit that changes nothing closes without a request.
test("saving an edit with no changes closes the dialog without a request", async () => {
  await renderEdit({
    providerId: "acme-com-oidc",
    type: "oidc",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    domainVerified: true,
    oidcConfig: { clientIdLastFour: "4321", pkce: true, scopes: ["openid"] },
    roleAttribute: null,
    adminRoleValue: null,
  });
  await flush();

  button("orgSave").click();
  await flush(3);

  assert.equal(state.updateProvider.mock.calls.length, 0, "no request is sent");
  assert.deepEqual(
    state.onOpenChange.mock.calls.at(-1),
    [false],
    "the dialog is closed",
  );
});

// W6 — a discovery / SSRF error is shown under the issuer field.
test("a private-host discovery error is shown under the issuer field", async () => {
  state.register.mockResolvedValue({
    error: {
      code: "discovery_private_host",
      message: "The host 10.0.0.1 is not publicly routable",
    },
  });
  await renderCreate();
  await flush();

  fillOidc();
  button("orgSave").click();
  await flush(3);

  assert(document.body.textContent?.includes("orgIssuerUnreachable"));
  assert(
    !document.body.textContent?.includes("not publicly routable"),
    "the raw English plugin message is never shown",
  );
});

// W6 — a duplicate providerId is routed to the provider-id field, localized.
test("a duplicate providerId shows a localized message on the provider-id field", async () => {
  state.register.mockResolvedValue({
    error: { message: "SSO provider with this providerId already exists" },
  });
  await renderCreate();
  await flush();

  fillOidc();
  button("orgSave").click();
  await flush(3);

  assert(document.body.textContent?.includes("orgProviderIdTaken"));
  assert(!document.body.textContent?.includes("already exists"));
});

// W3 — the identity-lock 409 is shown at form level and the dialog stays open.
test("a 409 identity-lock keeps the dialog open with a form-level message", async () => {
  state.updateProvider.mockResolvedValue({
    error: {
      status: 409,
      code: "SSO_PROVIDER_IDENTITY_LOCKED",
      message: "身份源身份字段已锁定。",
    },
  });
  await renderEdit({
    providerId: "acme-com-oidc",
    type: "oidc",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    domainVerified: true,
    oidcConfig: { clientIdLastFour: "4321", pkce: true, scopes: ["openid"] },
    roleAttribute: null,
    adminRoleValue: null,
  });
  await flush();

  typeInto(field("sso-issuer")!, "https://new-idp.acme.com");
  button("orgSave").click();
  await flush(3);

  assert.equal(state.updateProvider.mock.calls.length, 1);
  assert(document.body.textContent?.includes("身份源身份字段已锁定。"));
  assert(
    !state.onOpenChange.mock.calls.some((call) => call[0] === false),
    "the dialog is not closed",
  );
  // The admin's input is kept.
  assert.equal(field("sso-issuer")!.value, "https://new-idp.acme.com");
});

test("the edit dialog shows the identity-lock hint near the identity fields", async () => {
  await renderEdit({
    providerId: "acme-com-oidc",
    type: "oidc",
    issuer: "https://idp.acme.com",
    domain: "acme.com",
    domainVerified: true,
    oidcConfig: { clientIdLastFour: "4321", pkce: true, scopes: ["openid"] },
    roleAttribute: null,
    adminRoleValue: null,
  });
  await flush();

  assert(document.body.textContent?.includes("orgIdentityLockedHint"));
});
