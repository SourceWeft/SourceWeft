/**
 * Parse an IdP SAML metadata XML document in the browser to pre-fill the SAML
 * provider form. Pure and network-free: it uses `DOMParser` only, rejects any
 * document carrying a DOCTYPE (so no entity expansion is ever attempted), and
 * caps input at the backend plugin's `saml.maxMetadataSize` default (100 KiB).
 *
 * It extracts the values the registration needs as explicit fields — the IdP
 * SSO URL (`entryPoint`), the IdP entity ID, and the signing certificate — so
 * the admin can review and edit them before submitting. The submit path always
 * sends those explicit fields, never the raw XML.
 */

/** Matches the backend plugin's `saml.maxMetadataSize` default (100 KiB). */
export const MAX_METADATA_BYTES = 100 * 1024

const HTTP_REDIRECT_BINDING =
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
const HTTP_POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"

export type ParsedIdpMetadata = {
  /** IdP SSO URL (SingleSignOnService Location), Redirect binding preferred. */
  entryPoint?: string
  /** EntityDescriptor @entityID. */
  entityId?: string
  /** First signing certificate as bare base64 (whitespace stripped). */
  signingCert?: string
  /** True when the IdP publishes more than one signing certificate. */
  multipleSigningCerts: boolean
}

export type ParseIdpMetadataResult =
  | { ok: true; value: ParsedIdpMetadata }
  | { ok: false; reason: "too-large" | "doctype" | "not-xml" }

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

/** Elements with this local name, in any namespace (prefixed or not). */
function byLocalName(scope: Element | Document, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS("*", name))
}

function selectSsoUrl(scope: Element | Document): string | undefined {
  const services = byLocalName(scope, "SingleSignOnService")
  if (services.length === 0) return undefined
  const byBinding = (binding: string) =>
    services.find((service) => service.getAttribute("Binding") === binding)
  const chosen =
    byBinding(HTTP_REDIRECT_BINDING) ?? byBinding(HTTP_POST_BINDING) ?? services[0]
  return chosen?.getAttribute("Location")?.trim() || undefined
}

function collectSigningCerts(scope: Element | Document): string[] {
  const certs: string[] = []
  for (const keyDescriptor of byLocalName(scope, "KeyDescriptor")) {
    const use = keyDescriptor.getAttribute("use")
    // No `use` means the key is valid for signing (and encryption); skip
    // encryption-only keys.
    if (use && use !== "signing") continue
    const x509 = byLocalName(keyDescriptor, "X509Certificate")[0]
    const value = x509?.textContent?.replace(/\s+/g, "")
    if (value) certs.push(value)
  }
  return certs
}

export function parseIdpMetadata(xml: string): ParseIdpMetadataResult {
  if (byteLength(xml) > MAX_METADATA_BYTES) return { ok: false, reason: "too-large" }
  // Reject a DOCTYPE outright: it is the vector for entity-expansion attacks and
  // is never present in legitimate SAML metadata.
  if (/<!DOCTYPE/i.test(xml)) return { ok: false, reason: "doctype" }

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml")
  } catch {
    return { ok: false, reason: "not-xml" }
  }
  // A malformed document yields a <parsererror> element rather than throwing.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { ok: false, reason: "not-xml" }
  }

  const root = doc.documentElement
  if (!root || root.localName !== "EntityDescriptor") {
    return { ok: false, reason: "not-xml" }
  }

  const entityId = root.getAttribute("entityID")?.trim() || undefined
  const idp = byLocalName(doc, "IDPSSODescriptor")[0]
  const scope = idp ?? doc
  const entryPoint = selectSsoUrl(scope)
  const certs = collectSigningCerts(scope)

  return {
    ok: true,
    value: {
      entryPoint,
      entityId,
      signingCert: certs[0],
      multipleSigningCerts: certs.length > 1
    }
  }
}
