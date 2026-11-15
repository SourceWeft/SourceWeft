/**
 * Fail-closed SAML signature/digest algorithm policy (Task 6).
 *
 * `@better-auth/sso@1.7.7` does not enforce the response signature algorithm on
 * the HTTP-POST binding its ACS uses: the plugin only reads `parsedResponse.sigAlg`,
 * which `samlify`'s POST flow never populates, so a response signed with a
 * deprecated algorithm (RSA-SHA1, SHA-1 digest) is accepted end to end even with
 * `saml.algorithms = { onDeprecated: "reject" }`. This module is our own gate,
 * run as a guard before-hook on the SAML sign-in ACS endpoint before the plugin
 * processes the response.
 *
 * It is a pure, synchronous ALLOW-LIST check on the RAW decoded XML text — never
 * a blocklist, and it makes no trust decision (signature verification stays with
 * the plugin). The design intent is that an attacker who obfuscates the algorithm
 * declaration ends up REJECTED, never accepted, so every ambiguity fails closed:
 *
 *  - every `SignatureMethod` / `DigestMethod` element's `Algorithm` attribute
 *    must read, with certainty, as exactly one allow-listed URI (byte-for-byte:
 *    no normalisation, case folding, or trimming);
 *  - at least one of each must be present;
 *  - anything the scanner cannot read with certainty is rejected: non-base64 or
 *    non-UTF-8-XML input, oversized input, a `<!DOCTYPE`/`<!ENTITY`, an
 *    `EncryptedAssertion`/`EncryptedData` (whose inner signature cannot be
 *    inspected before decryption — phase 1 does not support encrypted assertions),
 *    an `Algorithm` value carrying a character/entity reference (`&`), a method
 *    tag whose `Algorithm` attribute cannot be read unambiguously (missing,
 *    duplicated, or a `>` inside another attribute truncating the tag), and a
 *    SHA-1 declaration sitting in a comment or CDATA alongside a real signature.
 *
 * A raw-text scan (not an XML parser) is deliberate: `apps/backend` has no direct
 * XML-parser dependency, and a parser that silently resolves entities or tolerates
 * malformed input would defeat the fail-closed guarantee. No dependency is added.
 */

/** XML Signature algorithm URIs (`<ds:SignatureMethod Algorithm="…">`) we accept. */
const ALLOWED_SIGNATURE_ALGORITHMS = new Set<string>([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
]);

/** XML Signature digest URIs (`<ds:DigestMethod Algorithm="…">`) we accept. */
const ALLOWED_DIGEST_ALGORITHMS = new Set<string>([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

/** Matches the plugin's own `saml.maxResponseSize` default (bytes of the base64). */
const MAX_RESPONSE_SIZE = 262144;

export type SamlAlgorithmRejectionReason =
  | "not_a_string"
  | "oversized"
  | "invalid_base64"
  | "not_utf8_xml"
  | "doctype_or_entity"
  | "encrypted_assertion"
  | "missing_signature_method"
  | "missing_digest_method"
  | "algorithm_declaration_unreadable"
  | "signature_algorithm_not_allowed"
  | "digest_algorithm_not_allowed";

export type SamlAlgorithmPolicyResult =
  | { ok: true }
  | { ok: false; reason: SamlAlgorithmRejectionReason };

function reject(reason: SamlAlgorithmRejectionReason): SamlAlgorithmPolicyResult {
  return { ok: false, reason };
}

/** Does the raw text contain a start tag whose local name is `localName`? */
function containsElement(text: string, localName: string): boolean {
  return new RegExp(`<([A-Za-z_][\\w.-]*:)?${localName}(?=[\\s/>])`).test(text);
}

type AlgorithmRead =
  | { kind: "ok"; value: string }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "reference" };

/**
 * Read the single `Algorithm` attribute from a method tag's attribute region
 * (the text between the element name and the first `>`). Fails closed: a region
 * that does not tokenise cleanly into `name="value"` attributes (e.g. because a
 * `>` inside another attribute truncated the tag), a missing or duplicated
 * `Algorithm`, or a value carrying a `&` reference all return a non-`ok` kind.
 * A prefixed `ns:Algorithm` attribute is a different name than the unprefixed
 * `Algorithm` the verifier reads, so it is ignored here.
 */
function readAlgorithm(region: string): AlgorithmRead {
  let rest = region.trim();
  // A self-closing tag's region ends with the `/` of `/>`.
  if (rest.endsWith("/")) {
    rest = rest.slice(0, -1).trimEnd();
  }
  const attribute = /^([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/;
  const algorithmValues: string[] = [];
  while (rest.length > 0) {
    const match = attribute.exec(rest);
    if (!match) {
      return { kind: "unreadable" };
    }
    if (match[1] === "Algorithm") {
      algorithmValues.push(match[2] ?? match[3] ?? "");
    }
    rest = rest.slice(match[0].length);
  }
  if (algorithmValues.length === 0) {
    return { kind: "missing" };
  }
  if (algorithmValues.length > 1) {
    return { kind: "unreadable" };
  }
  const value = algorithmValues[0]!;
  if (value.includes("&")) {
    return { kind: "reference" };
  }
  return { kind: "ok", value };
}

/** Validate every `localName` element's `Algorithm` against `allowed`. */
function checkMethods(
  text: string,
  localName: "SignatureMethod" | "DigestMethod",
  allowed: ReadonlySet<string>,
): { ok: true; count: number } | { ok: false; reason: SamlAlgorithmRejectionReason } {
  const notAllowed: SamlAlgorithmRejectionReason =
    localName === "SignatureMethod"
      ? "signature_algorithm_not_allowed"
      : "digest_algorithm_not_allowed";
  const finder = new RegExp(`<([A-Za-z_][\\w.-]*:)?${localName}(?=[\\s/>])`, "g");
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = finder.exec(text)) !== null) {
    count += 1;
    const close = text.indexOf(">", match.index);
    if (close === -1) {
      return { ok: false, reason: "algorithm_declaration_unreadable" };
    }
    const region = text.slice(match.index + match[0].length, close);
    const algorithm = readAlgorithm(region);
    if (algorithm.kind !== "ok") {
      return { ok: false, reason: "algorithm_declaration_unreadable" };
    }
    if (!allowed.has(algorithm.value)) {
      return { ok: false, reason: notAllowed };
    }
  }
  return { ok: true, count };
}

/**
 * Enforce the allow-list on a base64-encoded `SAMLResponse` form value. Pure and
 * synchronous; returns a discriminated result rather than throwing, so callers
 * (the guard) decide how to surface a rejection.
 */
export function assertSamlResponseAlgorithmsAllowed(
  samlResponseBase64: unknown,
): SamlAlgorithmPolicyResult {
  if (typeof samlResponseBase64 !== "string" || samlResponseBase64.length === 0) {
    return reject("not_a_string");
  }
  // The plugin caps the raw (pre-whitespace-strip) base64 at this size; match it.
  if (Buffer.byteLength(samlResponseBase64, "utf8") > MAX_RESPONSE_SIZE) {
    return reject("oversized");
  }

  const compact = samlResponseBase64.replace(/\s+/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    return reject("invalid_base64");
  }

  const bytes = Buffer.from(compact, "base64");
  // A NUL byte never appears in UTF-8 SAML XML; it does in UTF-16, so reject it.
  if (bytes.includes(0x00)) {
    return reject("not_utf8_xml");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reject("not_utf8_xml");
  }
  if (!text.includes("<")) {
    return reject("not_utf8_xml");
  }

  const lower = text.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<!entity")) {
    return reject("doctype_or_entity");
  }
  if (
    containsElement(text, "EncryptedAssertion") ||
    containsElement(text, "EncryptedData")
  ) {
    return reject("encrypted_assertion");
  }

  const signature = checkMethods(text, "SignatureMethod", ALLOWED_SIGNATURE_ALGORITHMS);
  if (!signature.ok) {
    return signature;
  }
  if (signature.count === 0) {
    return reject("missing_signature_method");
  }
  const digest = checkMethods(text, "DigestMethod", ALLOWED_DIGEST_ALGORITHMS);
  if (!digest.ok) {
    return digest;
  }
  if (digest.count === 0) {
    return reject("missing_digest_method");
  }

  return { ok: true };
}
