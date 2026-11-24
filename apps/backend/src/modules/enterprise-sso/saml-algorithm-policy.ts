import { DOMParser } from "@xmldom/xmldom";

/**
 * Fail-closed SAML signature/digest algorithm policy (Task 6).
 *
 * `@better-auth/sso@1.7.7` does not enforce the response signature algorithm on
 * the HTTP-POST binding its ACS uses, so a response signed with a deprecated
 * algorithm (RSA-SHA1, SHA-1 digest) is accepted end to end even with
 * `saml.algorithms = { onDeprecated: "reject" }`. This module is our own gate,
 * run as a guard before-hook on the SAML sign-in ACS endpoint before the plugin
 * processes the response.
 *
 * It does not scan text — a text scanner cannot be proven equivalent to a
 * RECOVERING XML parser, and the repo pins `@xmldom/xmldom` to 0.8.15, which
 * recovers malformed markup (unclosed/over-long end tags, stray `<`) silently or
 * with only a warning, so a hidden `<SignatureMethod Algorithm="…rsa-sha1"/>` the
 * verifier resolves can escape a scanner. Instead this policy inspects the DOM
 * produced by the SAME parser, version and input as the signature verifier
 * (`@xmldom/xmldom` 0.8.15 resolves to the same module `samlify`/`xml-crypto`
 * use — a unit test pins this), and rejects every document that parser reports
 * any problem with. A document that parses with no reported problem yields the
 * exact tree the verifier inspects, and every element the verifier could see is
 * walked and checked here; a document the parser would have to RECOVER is
 * rejected, because the parser is given an error handler that throws at every
 * level (warning, error, fatalError).
 *
 * The whole document is inspected in a SINGLE linear pass, with no re-traversal
 * of any subtree and no per-node array allocation, so cost is bounded by document
 * size (not by, e.g., the number of signatures times the tree size). The parse
 * and the walk run inside one try/catch, so any unexpected error becomes a
 * rejection result — this function never throws.
 *
 * Invariant: the policy inspects the DOM produced by the same parser, version and
 * input as the signature verifier, and rejects every document that parser reports
 * any problem with; every element whose local name is `SignatureMethod` or
 * `DigestMethod` (any namespace) in that tree carries exactly one unprefixed
 * `Algorithm` whose parsed value is an allow-listed URI, every `Signature` has a
 * `SignatureMethod` descendant, and every `Reference` a `DigestMethod` descendant.
 *
 * Documented limits (a real SAML response has one or two signatures, one
 * reference each and a shallow tree, so these never bind legitimate traffic):
 * at most {@link MAX_SIGNATURES} `Signature` elements, no `Signature` nested
 * inside another `Signature`, at most {@link MAX_REFERENCES} `Reference`
 * elements, element nesting depth at most {@link MAX_DEPTH}, and at most
 * {@link MAX_NODES} nodes. Comments, CDATA sections, processing instructions
 * (other than a single leading XML declaration), DOCTYPE/entities and encrypted
 * assertions are refused; and only RSA-SHA256/512 signatures and SHA-256/512
 * digests are allow-listed — RSA-PSS, RSA-SHA384, ECDSA and HMAC are rejected,
 * matching what xml-crypto 6.4.0 can both verify and we consider strong.
 */

/** SignatureMethod URIs we accept (both are registered in xml-crypto 6.4.0). */
const ALLOWED_SIGNATURE_ALGORITHMS = new Set<string>([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
]);

/** DigestMethod URIs we accept (both are registered in xml-crypto 6.4.0). */
const ALLOWED_DIGEST_ALGORITHMS = new Set<string>([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

/** Matches the plugin's own `saml.maxResponseSize` default (bytes of the base64). */
const MAX_RESPONSE_SIZE = 262144;

/**
 * Upper bound on nodes walked. A response under the size cap holds at most about
 * 49000 nodes (the densest packing is `<a/>`, four bytes each), and a real one
 * has a few hundred, so this is generous while still reachable by a stress test.
 */
const MAX_NODES = 30000;

/** A real SAML response carries one or two signatures; cap it well above that. */
const MAX_SIGNATURES = 8;
/** One Reference per signature is normal; cap the whole document generously. */
const MAX_REFERENCES = 32;
/** SAML trees are shallow; reject anything implausibly deep. */
const MAX_DEPTH = 64;

/** DOM node types (per the DOM spec; stable in @xmldom/xmldom 0.8.15). */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_TYPE_NODE = 10;

/** Local names that matter, compared case-insensitively for the "variant" check. */
const SENSITIVE_LOCAL_NAMES = new Set([
  "signaturemethod",
  "digestmethod",
  "encryptedassertion",
  "encrypteddata",
]);

export type SamlAlgorithmRejectionReason =
  | "not_a_string"
  | "oversized"
  | "invalid_base64"
  | "not_utf8_xml"
  | "non_utf8_declaration"
  | "doctype_or_entity"
  | "parser_reported_problem"
  | "no_document_element"
  | "comment"
  | "cdata"
  | "processing_instruction"
  | "document_type"
  | "text_outside_root"
  | "multiple_roots"
  | "too_many_nodes"
  | "too_deeply_nested"
  | "too_many_signatures"
  | "too_many_references"
  | "nested_signature"
  | "encrypted_assertion"
  | "suspicious_element_variant"
  | "algorithm_declaration_unreadable"
  | "algorithm_value_invalid"
  | "signature_algorithm_not_allowed"
  | "digest_algorithm_not_allowed"
  | "signature_without_method"
  | "reference_without_digest"
  | "missing_signature_method"
  | "missing_digest_method";

export type SamlAlgorithmPolicyResult =
  | { ok: true }
  | { ok: false; reason: SamlAlgorithmRejectionReason };

/** The narrow DOM shape this policy reads — avoids depending on `lib.dom`. */
interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly localName?: string | null;
  readonly data?: string | null;
  readonly childNodes?: ArrayLike<DomNode> | null;
  readonly attributes?: ArrayLike<DomNode> | null;
  getAttribute?(name: string): string | null;
}

interface DomDocument {
  readonly documentElement: DomNode | null;
  readonly childNodes?: ArrayLike<DomNode> | null;
}

function reject(
  reason: SamlAlgorithmRejectionReason,
): { ok: false; reason: SamlAlgorithmRejectionReason } {
  return { ok: false, reason };
}

/** The local name the verifier's XPath `local-name()` would see. */
function localNameOf(node: DomNode): string {
  if (node.localName) {
    return node.localName;
  }
  const name = node.nodeName;
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Validate a `SignatureMethod`/`DigestMethod` element's `Algorithm`. The element
 * must carry exactly one attribute whose local name is `Algorithm`, and it must
 * be the unprefixed one the verifier's `@Algorithm` reads; the value (as the
 * parser returns it, after entity/reference decoding) must be printable ASCII
 * with no whitespace and equal an allow-listed URI. Iterates attributes by index
 * (no array allocation).
 */
function checkMethod(
  element: DomNode,
  allowed: ReadonlySet<string>,
  notAllowed: SamlAlgorithmRejectionReason,
): SamlAlgorithmPolicyResult {
  const attributes = element.attributes;
  const length = attributes ? attributes.length : 0;
  let algorithmCount = 0;
  let algorithmNodeName = "";
  for (let i = 0; i < length; i += 1) {
    const attr = attributes![i]!;
    if (localNameOf(attr) === "Algorithm") {
      algorithmCount += 1;
      algorithmNodeName = attr.nodeName;
    }
  }
  if (algorithmCount !== 1) {
    return reject("algorithm_declaration_unreadable");
  }
  // `@Algorithm` / getAttribute("Algorithm") reads the UNPREFIXED attribute only.
  if (algorithmNodeName !== "Algorithm") {
    return reject("algorithm_declaration_unreadable");
  }
  const value = element.getAttribute?.("Algorithm") ?? null;
  if (value === null) {
    return reject("algorithm_declaration_unreadable");
  }
  // Printable ASCII, no whitespace (the allow-listed URIs are exactly this).
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return reject("algorithm_value_invalid");
  }
  if (!allowed.has(value)) {
    return reject(notAllowed);
  }
  return { ok: true };
}

/** Records whether a `Signature` subtree has yet seen its own `SignatureMethod`. */
interface SignatureContext {
  sawMethod: boolean;
}
/** Records whether a `Reference` subtree has yet seen its own `DigestMethod`. */
interface ReferenceContext {
  sawDigest: boolean;
}

/** A frame on the explicit traversal stack: a node to visit, or a subtree close. */
type WalkFrame =
  | {
      kind: "node";
      node: DomNode;
      depth: number;
      signature: SignatureContext | null;
      reference: ReferenceContext | null;
    }
  | { kind: "closeSignature"; context: SignatureContext }
  | { kind: "closeReference"; context: ReferenceContext };

/**
 * Walk the parsed tree once, enforcing the allow-list, the structural rules and
 * the hard limits. Iterative (no recursion, so depth cannot overflow the stack)
 * and single-pass: the per-`Signature`/`Reference` "has a method/digest" checks
 * are folded into the walk via close-markers and the nearest-enclosing context
 * carried on each stack frame, so no subtree is re-traversed.
 */
function walkDocument(document: DomDocument): SamlAlgorithmPolicyResult {
  if (!document.documentElement) {
    return reject("no_document_element");
  }

  // Document-level children: a single leading XML declaration (a PI whose target
  // is "xml", and only as the very first node), exactly one root element, and
  // only whitespace text — reject comments, CDATA, any other PI, a DOCTYPE,
  // non-whitespace text (content outside the root) and a second root element.
  const documentChildren = document.childNodes;
  const documentChildCount = documentChildren ? documentChildren.length : 0;
  let roots = 0;
  for (let i = 0; i < documentChildCount; i += 1) {
    const child = documentChildren![i]!;
    switch (child.nodeType) {
      case ELEMENT_NODE:
        roots += 1;
        if (roots > 1) {
          return reject("multiple_roots");
        }
        break;
      case PROCESSING_INSTRUCTION_NODE:
        if (i !== 0 || child.nodeName !== "xml") {
          return reject("processing_instruction");
        }
        break;
      case COMMENT_NODE:
        return reject("comment");
      case CDATA_SECTION_NODE:
        return reject("cdata");
      case DOCUMENT_TYPE_NODE:
        return reject("document_type");
      case TEXT_NODE:
        if ((child.data ?? "").trim().length > 0) {
          return reject("text_outside_root");
        }
        break;
      default:
        break;
    }
  }
  if (roots !== 1) {
    return reject("no_document_element");
  }

  let signatureMethods = 0;
  let digestMethods = 0;
  let signatureCount = 0;
  let referenceCount = 0;
  let nodeCount = 0;

  const stack: WalkFrame[] = [
    { kind: "node", node: document.documentElement, depth: 0, signature: null, reference: null },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "closeSignature") {
      if (!frame.context.sawMethod) {
        return reject("signature_without_method");
      }
      continue;
    }
    if (frame.kind === "closeReference") {
      if (!frame.context.sawDigest) {
        return reject("reference_without_digest");
      }
      continue;
    }

    nodeCount += 1;
    if (nodeCount > MAX_NODES) {
      return reject("too_many_nodes");
    }
    if (frame.depth > MAX_DEPTH) {
      return reject("too_deeply_nested");
    }

    const node = frame.node;
    let signature = frame.signature;
    let reference = frame.reference;

    switch (node.nodeType) {
      case COMMENT_NODE:
        return reject("comment");
      case CDATA_SECTION_NODE:
        return reject("cdata");
      case DOCUMENT_TYPE_NODE:
        return reject("document_type");
      case PROCESSING_INSTRUCTION_NODE:
        // No processing instruction may appear inside the root element.
        return reject("processing_instruction");
      case ELEMENT_NODE: {
        const localName = localNameOf(node);
        if (localName === "EncryptedAssertion" || localName === "EncryptedData") {
          return reject("encrypted_assertion");
        }
        if (localName === "SignatureMethod") {
          const result = checkMethod(
            node,
            ALLOWED_SIGNATURE_ALGORITHMS,
            "signature_algorithm_not_allowed",
          );
          if (!result.ok) {
            return result;
          }
          signatureMethods += 1;
          if (signature) {
            signature.sawMethod = true;
          }
        } else if (localName === "DigestMethod") {
          const result = checkMethod(
            node,
            ALLOWED_DIGEST_ALGORITHMS,
            "digest_algorithm_not_allowed",
          );
          if (!result.ok) {
            return result;
          }
          digestMethods += 1;
          if (reference) {
            reference.sawDigest = true;
          }
        } else if (SENSITIVE_LOCAL_NAMES.has(localName.toLowerCase())) {
          return reject("suspicious_element_variant");
        } else if (localName === "Signature") {
          if (signature) {
            return reject("nested_signature");
          }
          signatureCount += 1;
          if (signatureCount > MAX_SIGNATURES) {
            return reject("too_many_signatures");
          }
          const context: SignatureContext = { sawMethod: false };
          stack.push({ kind: "closeSignature", context });
          signature = context;
        } else if (localName === "Reference") {
          referenceCount += 1;
          if (referenceCount > MAX_REFERENCES) {
            return reject("too_many_references");
          }
          const context: ReferenceContext = { sawDigest: false };
          stack.push({ kind: "closeReference", context });
          reference = context;
        }

        // Push children by index (no array allocation), reversed so they pop in
        // document order, carrying the nearest enclosing Signature/Reference.
        const children = node.childNodes;
        const childCount = children ? children.length : 0;
        for (let i = childCount - 1; i >= 0; i -= 1) {
          stack.push({
            kind: "node",
            node: children![i]!,
            depth: frame.depth + 1,
            signature,
            reference,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  if (signatureMethods === 0) {
    return reject("missing_signature_method");
  }
  if (digestMethods === 0) {
    return reject("missing_digest_method");
  }
  return { ok: true };
}

/** An error handler that throws at every level, so any reported problem rejects. */
const THROWING_ERROR_HANDLER = {
  warning: (message: string) => {
    throw new Error(message);
  },
  error: (message: string) => {
    throw new Error(message);
  },
  fatalError: (message: string) => {
    throw new Error(message);
  },
};

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

  // Strict base64 over the whitespace-stripped value, so the bytes we parse are
  // exactly the bytes samlify decodes.
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

  // Raw-text guards applied before parsing: no DOCTYPE/entities reach the parser,
  // and a declaration naming a non-UTF-8 encoding (the bytes are UTF-8) is refused.
  const lower = text.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<!entity")) {
    return reject("doctype_or_entity");
  }
  let afterDeclaration = 0;
  if (text.startsWith("<?xml")) {
    const close = text.indexOf("?>");
    if (close === -1) {
      return reject("processing_instruction");
    }
    const encoding = /\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(
      text.slice(0, close + 2),
    );
    if (encoding) {
      const value = (encoding[1] ?? encoding[2] ?? "").toLowerCase();
      if (value !== "utf-8" && value !== "utf8") {
        return reject("non_utf8_declaration");
      }
    }
    afterDeclaration = close + 2;
  }
  // Non-whitespace text before the root element: @xmldom/xmldom 0.8.15 silently
  // DROPS leading text (it is not in the tree), so the DOM walk cannot see it;
  // reject it here. Trailing text after the root IS kept as a document child and
  // is caught by the walk.
  const beforeRoot = text.slice(afterDeclaration);
  const firstMarkup = beforeRoot.indexOf("<");
  if (firstMarkup > 0 && beforeRoot.slice(0, firstMarkup).trim().length > 0) {
    return reject("text_outside_root");
  }

  // Parse with the SAME parser the verifier uses, throwing on any reported
  // problem, and inspect the tree. Both run inside one try/catch so any
  // unexpected error (a reported problem, or a hostile DOM object) becomes a
  // rejection — this function never throws past here.
  try {
    const document = new DOMParser({
      errorHandler: THROWING_ERROR_HANDLER,
    }).parseFromString(text, "text/xml") as unknown as DomDocument;
    return walkDocument(document);
  } catch {
    return reject("parser_reported_problem");
  }
}
