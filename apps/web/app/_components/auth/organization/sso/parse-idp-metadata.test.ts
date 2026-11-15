// @vitest-environment jsdom

import assert from "node:assert/strict";
import { test } from "vitest";

import { MAX_METADATA_BYTES, parseIdpMetadata } from "./parse-idp-metadata";

// Okta-style: `md:` / `ds:` prefixes, one signing cert, POST listed before
// Redirect (Redirect must still win).
const OKTA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://www.okta.com/exk1fake">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>MIIOKTA
aSignedCertBody==</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://acme.okta.com/app/acme/exk1fake/sso/saml/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://acme.okta.com/app/acme/exk1fake/sso/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

// Entra-ID-style: default (unprefixed) namespaces, two signing certs.
const ENTRA = `<?xml version="1.0" encoding="utf-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sts.windows.net/00000000-tenant/">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>ENTRAPRIMARYCERT==</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>ENTRASECONDARYCERT==</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/00000000-tenant/saml2"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://login.microsoftonline.com/00000000-tenant/saml2"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

test("parses Okta-style metadata, preferring the HTTP-Redirect SSO URL", () => {
  const result = parseIdpMetadata(OKTA);
  assert(result.ok);
  assert.equal(result.value.entityId, "http://www.okta.com/exk1fake");
  assert.equal(
    result.value.entryPoint,
    "https://acme.okta.com/app/acme/exk1fake/sso/saml",
  );
  // Whitespace inside the certificate body is stripped to bare base64.
  assert.equal(result.value.signingCert, "MIIOKTAaSignedCertBody==");
  assert.equal(result.value.multipleSigningCerts, false);
});

test("parses Entra-ID-style metadata with unprefixed namespaces and flags multiple certs", () => {
  const result = parseIdpMetadata(ENTRA);
  assert(result.ok);
  assert.equal(result.value.entityId, "https://sts.windows.net/00000000-tenant/");
  assert.equal(
    result.value.entryPoint,
    "https://login.microsoftonline.com/00000000-tenant/saml2",
  );
  // The first signing certificate is used.
  assert.equal(result.value.signingCert, "ENTRAPRIMARYCERT==");
  assert.equal(result.value.multipleSigningCerts, true);
});

test("falls back to HTTP-POST when no Redirect binding is present", () => {
  const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:idp">
    <IDPSSODescriptor>
      <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>CERT</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/post"/>
    </IDPSSODescriptor>
  </EntityDescriptor>`;
  const result = parseIdpMetadata(xml);
  assert(result.ok);
  assert.equal(result.value.entryPoint, "https://idp.example.com/post");
});

test("treats a KeyDescriptor with no `use` attribute as a signing certificate", () => {
  const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:idp">
    <IDPSSODescriptor>
      <KeyDescriptor><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>NOUSECERT</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
    </IDPSSODescriptor>
  </EntityDescriptor>`;
  const result = parseIdpMetadata(xml);
  assert(result.ok);
  assert.equal(result.value.signingCert, "NOUSECERT");
});

test("ignores an encryption-only KeyDescriptor so the signing cert is reported missing", () => {
  const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:idp">
    <IDPSSODescriptor>
      <KeyDescriptor use="encryption"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>ENCONLY</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
    </IDPSSODescriptor>
  </EntityDescriptor>`;
  const result = parseIdpMetadata(xml);
  assert(result.ok);
  assert.equal(result.value.signingCert, undefined);
});

test("reports a missing SSO service as an absent entryPoint", () => {
  const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:idp">
    <IDPSSODescriptor>
      <KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>CERT</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    </IDPSSODescriptor>
  </EntityDescriptor>`;
  const result = parseIdpMetadata(xml);
  assert(result.ok);
  assert.equal(result.value.entryPoint, undefined);
  assert.equal(result.value.entityId, "urn:idp");
  assert.equal(result.value.signingCert, "CERT");
});

test("rejects a document with a DOCTYPE", () => {
  const xml = `<!DOCTYPE EntityDescriptor><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:idp"></EntityDescriptor>`;
  const result = parseIdpMetadata(xml);
  assert(!result.ok);
  assert.equal(result.reason, "doctype");
});

test("rejects non-XML input", () => {
  const result = parseIdpMetadata("this is not metadata { json: true }");
  assert(!result.ok);
  assert.equal(result.reason, "not-xml");
});

test("rejects a non-metadata XML root", () => {
  const result = parseIdpMetadata("<html><body>nope</body></html>");
  assert(!result.ok);
  assert.equal(result.reason, "not-xml");
});

test("rejects oversize input before parsing", () => {
  const xml = `<EntityDescriptor entityID="urn:idp">${"x".repeat(MAX_METADATA_BYTES + 1)}</EntityDescriptor>`;
  const result = parseIdpMetadata(xml);
  assert(!result.ok);
  assert.equal(result.reason, "too-large");
});
