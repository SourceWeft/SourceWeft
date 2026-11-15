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
 * It is a pure, synchronous check on the RAW decoded XML text — an ALLOW-LIST,
 * never a blocklist — and it makes no trust decision (signature verification
 * stays with the plugin). It does not pattern-match for the two element names
 * (that was bypassable with a non-ASCII namespace prefix, which `@xmldom/xmldom`
 * parses and `xml-crypto` resolves by LOCAL NAME regardless of prefix). Instead
 * it tokenises EVERY piece of markup and fails closed on anything it cannot
 * positively recognise, so the output guarantees this invariant:
 *
 *   every element any XML parser can see in this document has an ASCII NCName,
 *   and every element whose local name is `SignatureMethod` or `DigestMethod`
 *   carries an allow-listed `Algorithm`.
 *
 * How: walk every `<` (in well-formed XML a raw `<` always starts markup — text
 * and attribute values cannot contain one — so this enumeration is complete);
 * reject comments, CDATA, DOCTYPE / any `<!` declaration, and any processing
 * instruction other than a single leading `<?xml …?>`; require every start /
 * empty-element tag name to be an ASCII NCName (optional single ASCII prefix),
 * scanning each tag's end quote-aware so a `>` inside a quoted attribute value
 * never ends it early (unbalanced quotes reject); validate the `Algorithm` of
 * every exact-`SignatureMethod`/`DigestMethod` tag (exactly one unprefixed
 * `Algorithm`, byte-for-byte allow-listed, no `&`); reject any element whose
 * local name case-insensitively matches a sensitive name but not exactly; reject
 * `EncryptedAssertion`/`EncryptedData`; and require at least one of each method.
 *
 * Documented limitations: RSA-PSS (`…2007/05/xmldsig-more#sha256-rsa-MGF1`) is
 * not on the allow-list; responses containing XML comments, CDATA sections, or
 * encrypted assertions are refused (phase 1 does not need any of them). A raw-text
 * scan rather than an XML parser is deliberate — `apps/backend` has no direct
 * XML-parser dependency, and a parser that silently resolves entities or tolerates
 * malformed input would defeat the fail-closed guarantee. No dependency is added.
 */

/** XML Signature algorithm URIs (`SignatureMethod/@Algorithm`) we accept. */
const ALLOWED_SIGNATURE_ALGORITHMS = new Set<string>([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
]);

/** XML Signature digest URIs (`DigestMethod/@Algorithm`) we accept. */
const ALLOWED_DIGEST_ALGORITHMS = new Set<string>([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

/** Matches the plugin's own `saml.maxResponseSize` default (bytes of the base64). */
const MAX_RESPONSE_SIZE = 262144;

/** Local names that matter, compared case-insensitively for the "variant" check. */
const SENSITIVE_LOCAL_NAMES = new Set([
  "signaturemethod",
  "digestmethod",
  "encryptedassertion",
  "encrypteddata",
]);

/** ASCII NCName, optionally prefixed by a single ASCII NCName and a colon. */
const ASCII_QNAME = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/;

export type SamlAlgorithmRejectionReason =
  | "not_a_string"
  | "oversized"
  | "invalid_base64"
  | "not_utf8_xml"
  | "non_utf8_declaration"
  | "comment"
  | "cdata"
  | "doctype_or_entity"
  | "processing_instruction"
  | "tag_name_not_ncname"
  | "unterminated_tag"
  | "unbalanced_quote"
  | "suspicious_element_variant"
  | "encrypted_assertion"
  | "missing_signature_method"
  | "missing_digest_method"
  | "algorithm_declaration_unreadable"
  | "algorithm_value_has_reference"
  | "signature_algorithm_not_allowed"
  | "digest_algorithm_not_allowed";

export type SamlAlgorithmPolicyResult =
  | { ok: true }
  | { ok: false; reason: SamlAlgorithmRejectionReason };

function reject(reason: SamlAlgorithmRejectionReason): { ok: false; reason: SamlAlgorithmRejectionReason } {
  return { ok: false, reason };
}

type ParsedStartTag =
  | { ok: true; end: number; localName: string; attrsRegion: string }
  | { ok: false; reason: SamlAlgorithmRejectionReason };

/**
 * Parse one start / empty-element tag beginning at `start` (the `<`). Reads the
 * name up to the first whitespace, `/` or `>`, requires an ASCII QName, then
 * finds the tag's real `>` with a quote-aware scan (a `>` inside a quoted
 * attribute value does not end the tag; an unbalanced quote rejects).
 */
function parseStartTag(text: string, start: number): ParsedStartTag {
  let nameEnd = start + 1;
  while (nameEnd < text.length && !/[\s/>]/.test(text[nameEnd]!)) {
    nameEnd += 1;
  }
  const name = text.slice(start + 1, nameEnd);
  if (!ASCII_QNAME.test(name)) {
    return reject("tag_name_not_ncname");
  }

  let i = nameEnd;
  let quote: '"' | "'" | null = null;
  let close = -1;
  while (i < text.length) {
    const char = text[i]!;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      i += 1;
      continue;
    }
    if (char === ">") {
      close = i;
      break;
    }
    i += 1;
  }
  if (close === -1) {
    return reject(quote !== null ? "unbalanced_quote" : "unterminated_tag");
  }

  const inner = text.slice(nameEnd, close);
  const withoutTrailingSpace = inner.replace(/\s+$/, "");
  const selfClosing = withoutTrailingSpace.endsWith("/");
  const attrsRegion = selfClosing ? withoutTrailingSpace.slice(0, -1) : inner;
  const colon = name.indexOf(":");
  const localName = colon === -1 ? name : name.slice(colon + 1);
  return { ok: true, end: close + 1, localName, attrsRegion };
}

/**
 * Validate a `SignatureMethod`/`DigestMethod` tag's `Algorithm` against `allowed`.
 * Fails closed: the attribute region must tokenise cleanly into quoted
 * `name="value"` pairs (leftover junk, or an unquoted value, rejects); there must
 * be exactly one attribute named exactly `Algorithm` (a prefixed `ns:Algorithm`
 * is a different name the verifier ignores, so it does not count); the value must
 * carry no `&` reference and equal an allow-listed URI byte-for-byte.
 */
function checkAlgorithm(
  attrsRegion: string,
  allowed: ReadonlySet<string>,
  notAllowed: SamlAlgorithmRejectionReason,
): SamlAlgorithmPolicyResult {
  let rest = attrsRegion.trim();
  const attribute = /^([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/;
  const values: string[] = [];
  while (rest.length > 0) {
    const match = attribute.exec(rest);
    if (!match) {
      return reject("algorithm_declaration_unreadable");
    }
    if (match[1] === "Algorithm") {
      values.push(match[2] ?? match[3] ?? "");
    }
    rest = rest.slice(match[0].length);
  }
  if (values.length !== 1) {
    return reject("algorithm_declaration_unreadable");
  }
  const value = values[0]!;
  if (value.includes("&")) {
    return reject("algorithm_value_has_reference");
  }
  if (!allowed.has(value)) {
    return reject(notAllowed);
  }
  return { ok: true };
}

/** Walk every tag, rejecting on the first thing not positively recognised. */
function tokenizeAndCheck(text: string, start: number): SamlAlgorithmPolicyResult {
  let i = start;
  let signatureMethods = 0;
  let digestMethods = 0;

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    if (text.startsWith("<!--", lt)) {
      return reject("comment");
    }
    if (text.startsWith("<![CDATA[", lt)) {
      return reject("cdata");
    }
    if (text.startsWith("<!", lt)) {
      return reject("doctype_or_entity");
    }
    if (text.startsWith("<?", lt)) {
      // The only legitimate PI is a leading XML declaration, consumed before this.
      return reject("processing_instruction");
    }
    if (text.startsWith("</", lt)) {
      // End tag: no attributes, so no quoted `>`; scan to the next `>`.
      const gt = text.indexOf(">", lt);
      if (gt === -1) {
        return reject("unterminated_tag");
      }
      i = gt + 1;
      continue;
    }

    const tag = parseStartTag(text, lt);
    if (!tag.ok) {
      return tag;
    }
    const localName = tag.localName;
    if (localName === "SignatureMethod") {
      const result = checkAlgorithm(
        tag.attrsRegion,
        ALLOWED_SIGNATURE_ALGORITHMS,
        "signature_algorithm_not_allowed",
      );
      if (!result.ok) {
        return result;
      }
      signatureMethods += 1;
    } else if (localName === "DigestMethod") {
      const result = checkAlgorithm(
        tag.attrsRegion,
        ALLOWED_DIGEST_ALGORITHMS,
        "digest_algorithm_not_allowed",
      );
      if (!result.ok) {
        return result;
      }
      digestMethods += 1;
    } else if (localName === "EncryptedAssertion" || localName === "EncryptedData") {
      return reject("encrypted_assertion");
    } else if (SENSITIVE_LOCAL_NAMES.has(localName.toLowerCase())) {
      // A case-variant of a sensitive name (e.g. `signaturemethod`): suspicious.
      return reject("suspicious_element_variant");
    }
    i = tag.end;
  }

  if (signatureMethods === 0) {
    return reject("missing_signature_method");
  }
  if (digestMethods === 0) {
    return reject("missing_digest_method");
  }
  return { ok: true };
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
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reject("not_utf8_xml");
  }
  // TextDecoder usually consumes a UTF-8 BOM already; strip a residual one.
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  if (!text.includes("<")) {
    return reject("not_utf8_xml");
  }

  // An optional single leading XML declaration (`<?xml …?>`) at the very start.
  let cursor = 0;
  if (text.startsWith("<?xml")) {
    const afterPrefix = text[5];
    if (afterPrefix !== undefined && !/[\s?]/.test(afterPrefix)) {
      return reject("processing_instruction"); // e.g. `<?xmlfoo…` — a PI, not a declaration
    }
    const close = text.indexOf("?>");
    if (close === -1) {
      return reject("processing_instruction");
    }
    const declaration = text.slice(0, close + 2);
    const encoding = /\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(declaration);
    if (encoding) {
      const value = (encoding[1] ?? encoding[2] ?? "").toLowerCase();
      if (value !== "utf-8" && value !== "utf8") {
        return reject("non_utf8_declaration");
      }
    }
    cursor = close + 2;
  }

  return tokenizeAndCheck(text, cursor);
}
