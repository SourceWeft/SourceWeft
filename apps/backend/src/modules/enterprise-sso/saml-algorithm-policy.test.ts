import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { createSamlIdpFixture } from "../../test/saml-fixture";
import {
  assertSamlResponseAlgorithmsAllowed,
  type SamlAlgorithmRejectionReason,
} from "./saml-algorithm-policy";

const SIG_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SIG_SHA512 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512";
const SIG_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const SIG_SHA384 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384";
const SIG_ECDSA = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";
const SIG_HMAC = "http://www.w3.org/2000/09/xmldsig#hmac-sha256";
const SIG_PSS = "http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1";
const DIG_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const DIG_SHA512 = "http://www.w3.org/2001/04/xmlenc#sha512";
const DIG_SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";

function base64(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

/** A Signature whose SignedInfo carries `inner` before the (decoy) method tags. */
function signedResponse(inner = "", sm = SIG_SHA256, dm = DIG_SHA256): string {
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
    `<saml:Assertion ID="_a"><ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="${EXC_C14N}"/>` +
    inner +
    `<ds:SignatureMethod Algorithm="${sm}"/>` +
    `<ds:Reference URI="#_a"><ds:DigestMethod Algorithm="${dm}"/><ds:DigestValue>x</ds:DigestValue></ds:Reference>` +
    `</ds:SignedInfo><ds:SignatureValue>x</ds:SignatureValue></ds:Signature></saml:Assertion></samlp:Response>`
  );
}

/** A single `<ds:Signature>` fragment with the given algorithms. */
function signatureFragment(sm = SIG_SHA256, dm = DIG_SHA256): string {
  return (
    `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo>` +
    `<ds:SignatureMethod Algorithm="${sm}"/>` +
    `<ds:Reference><ds:DigestMethod Algorithm="${dm}"/></ds:Reference>` +
    `</ds:SignedInfo></ds:Signature>`
  );
}

/** Wrap body content in a minimal `<samlp:Response>`. */
function wrap(body: string): string {
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xenc="u">` +
    body +
    `</samlp:Response>`
  );
}

function assertOk(xml: string): void {
  expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({ ok: true });
}
function assertRejected(input: string): void {
  expect(assertSamlResponseAlgorithmsAllowed(input).ok).toBe(false);
}
function assertReason(xml: string, reason: SamlAlgorithmRejectionReason): void {
  expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({ ok: false, reason });
}

describe("assertSamlResponseAlgorithmsAllowed (parsed-document policy)", () => {
  // The "same parser" premise: the policy must inspect the exact tree the verifier
  // (samlify/xml-crypto) inspects, which only holds while both resolve the same
  // @xmldom/xmldom. If a dependency change makes them differ, the policy's
  // guarantee is void and this test fails loudly.
  test("every parser in the verifier stack resolves the same @xmldom/xmldom the backend imports", () => {
    const here = createRequire(import.meta.url);
    const xmldomVersionFrom = (fromPath: string): string =>
      createRequire(fromPath)("@xmldom/xmldom/package.json").version as string;
    const backendVersion = here("@xmldom/xmldom/package.json").version as string;

    const samlifyEntry = here.resolve("samlify");
    const xmlCryptoEntry = createRequire(samlifyEntry).resolve("xml-crypto");
    const ssoEntry = here.resolve("@better-auth/sso");
    const message =
      "The policy inspects the DOM produced by @xmldom/xmldom; if any parser in the " +
      "signature-verifier stack resolves a DIFFERENT @xmldom/xmldom version, the policy " +
      "no longer inspects the same tree the verifier does and its guarantee is void.";

    for (const [name, entry] of [
      ["samlify", samlifyEntry],
      ["xml-crypto (via samlify)", xmlCryptoEntry],
      ["@better-auth/sso", ssoEntry],
    ] as const) {
      expect(xmldomVersionFrom(entry), `${name}: ${message}`).toBe(backendVersion);
    }
    expect(backendVersion.startsWith("0.8.")).toBe(true);
  });

  // ── Happy paths ─────────────────────────────────────────────────────────────

  test("accepts rsa-sha256 + sha256", () => assertOk(signedResponse()));
  test("accepts rsa-sha512 + sha512", () =>
    assertOk(signedResponse("", SIG_SHA512, DIG_SHA512)));

  test("accepts a real samlify-signed fixture response", () => {
    const fixture = createSamlIdpFixture();
    const samlResponse = fixture.buildResponse({
      acsUrl: "http://localhost:3001/api/auth/sso/saml2/sp/acs/p",
      audience: "https://sp/p",
      inResponseTo: "_req1",
      nameId: "a@b.com",
      email: "a@b.com",
    });
    expect(assertSamlResponseAlgorithmsAllowed(samlResponse)).toEqual({ ok: true });
  });

  test("accepts a realistic Okta/Entra/Keycloak-shape response (decl, &amp;, KeyInfo, Transforms)", () => {
    assertOk(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" Destination="https://sp/acs?a=1&amp;b=2">` +
        `<saml2:Assertion ID="_a"><ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo>` +
        `<ds:CanonicalizationMethod Algorithm="${EXC_C14N}"><ec:InclusiveNamespaces xmlns:ec="${EXC_C14N}" PrefixList="saml2p saml2"/></ds:CanonicalizationMethod>` +
        `<ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
        `<ds:Reference URI="#_a"><ds:Transforms><ds:Transform Algorithm="${DSIG_NS}enveloped-signature"/><ds:Transform Algorithm="${EXC_C14N}"/></ds:Transforms><ds:DigestMethod Algorithm="${DIG_SHA256}"/><ds:DigestValue>abcd==</ds:DigestValue></ds:Reference>` +
        `</ds:SignedInfo><ds:SignatureValue>c2ln</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIdummy==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>` +
        `<saml2:Subject><saml2:NameID>u@example.com</saml2:NameID></saml2:Subject></saml2:Assertion></saml2p:Response>`,
    );
  });

  test("accepts a valid response with an explicit UTF-8 XML declaration", () =>
    assertOk(`<?xml version="1.0" encoding="UTF-8"?>${signedResponse()}`));
  test("accepts a valid response with a leading BOM and an XML declaration", () =>
    assertOk(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>${signedResponse()}`));

  // Changed expectation vs the text-scanner policy: the parsed Algorithm value is
  // entity-decoded, so an entity-encoded but allow-listed URI now equals the
  // allow-listed string and is ACCEPTED (the verifier reads the same decoded value).
  test("accepts an entity-encoded but allow-listed Algorithm URI", () =>
    assertOk(signedResponse("", `http://www.w3.org/2001/04/xmldsig-more#&#114;sa-sha256`)));
  test("accepts an allow-listed URI quoted with single quotes", () =>
    assertOk(
      wrap(
        `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo>` +
          `<ds:SignatureMethod Algorithm='${SIG_SHA256}'/>` +
          `<ds:Reference><ds:DigestMethod Algorithm='${DIG_SHA256}'/></ds:Reference>` +
          `</ds:SignedInfo></ds:Signature>`,
      ),
    ));
  // Changed expectation: a non-ASCII namespace prefix with an ALLOW-LISTED algorithm
  // is now ACCEPTED — xmldom parses it as a SignatureMethod with that algorithm, the
  // same element and value the verifier resolves.
  test("accepts a non-ASCII-prefixed SignatureMethod with an allow-listed algorithm", () =>
    assertOk(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
        `<saml:Assertion ID="_a"><ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo>` +
        `<é:SignatureMethod xmlns:é="${DSIG_NS}" Algorithm="${SIG_SHA256}"/>` +
        `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>` +
        `</ds:SignedInfo></ds:Signature></saml:Assertion></samlp:Response>`,
    ));

  // ── Algorithm allow-list ────────────────────────────────────────────────────

  test("rejects rsa-sha1", () => assertReason(signedResponse("", SIG_SHA1), "signature_algorithm_not_allowed"));
  test("rejects a sha1 digest", () => assertReason(signedResponse("", SIG_SHA256, DIG_SHA1), "digest_algorithm_not_allowed"));
  test("rejects rsa-sha384 (not allow-listed)", () => assertReason(signedResponse("", SIG_SHA384), "signature_algorithm_not_allowed"));
  test("rejects ecdsa-sha256 (not allow-listed)", () => assertReason(signedResponse("", SIG_ECDSA), "signature_algorithm_not_allowed"));
  test("rejects hmac-sha256 (not allow-listed)", () => assertReason(signedResponse("", SIG_HMAC), "signature_algorithm_not_allowed"));
  test("rejects RSA-PSS sha256-rsa-MGF1 (documented limitation)", () => assertReason(signedResponse("", SIG_PSS), "signature_algorithm_not_allowed"));
  test("rejects two signatures where the second uses rsa-sha1", () =>
    assertRejected(base64(wrap(signatureFragment(SIG_SHA256) + signatureFragment(SIG_SHA1)))));

  // Changed reason: the parsed value is decoded, so `rsa-sha&#49;` decodes to
  // "rsa-sha1" — not an allow-listed URI — and is rejected as such.
  test("rejects a decoded Algorithm that is not an allow-listed URI", () =>
    assertReason(signedResponse("", "rsa-sha&#49;"), "signature_algorithm_not_allowed"));
  test("rejects an allow-listed URI with a trailing space (value has whitespace)", () =>
    assertReason(signedResponse("", `${SIG_SHA256} `), "algorithm_value_invalid"));
  test("rejects an allow-listed URI with a tab/newline inside (normalised to a space)", () =>
    assertReason(signedResponse("", `${SIG_SHA256}\n`), "algorithm_value_invalid"));
  test("rejects an allow-listed URI in a different case", () =>
    assertReason(signedResponse("", SIG_SHA256.toUpperCase()), "signature_algorithm_not_allowed"));

  // ── Attribute shape ─────────────────────────────────────────────────────────

  test("rejects a SignatureMethod with only a lower-case `algorithm` attribute", () =>
    assertReason(signedResponse(`<ds:SignatureMethod algorithm="${SIG_SHA256}"/>`), "algorithm_declaration_unreadable"));
  test("rejects a SignatureMethod with only a prefixed `ds:Algorithm`", () =>
    assertReason(signedResponse(`<ds:SignatureMethod ds:Algorithm="${SIG_SHA256}"/>`), "algorithm_declaration_unreadable"));
  test("rejects a duplicate Algorithm attribute (the parser reports it)", () =>
    assertReason(signedResponse(`<ds:SignatureMethod Algorithm="${SIG_SHA256}" Algorithm="${SIG_SHA1}"/>`), "parser_reported_problem"));

  // ── Element structure ───────────────────────────────────────────────────────

  test("rejects an EncryptedAssertion", () =>
    assertReason(wrap(signatureFragment() + `<saml:EncryptedAssertion/>`), "encrypted_assertion"));
  test("rejects a bare EncryptedData element", () =>
    assertReason(wrap(signatureFragment() + `<xenc:EncryptedData/>`), "encrypted_assertion"));
  test("rejects a lower-case `signaturemethod` element (suspicious variant)", () =>
    assertReason(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:signaturemethod Algorithm="${SIG_SHA256}"/><ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference></ds:SignedInfo></ds:Signature></samlp:Response>`,
      "suspicious_element_variant",
    ));
  test("rejects a response with no SignatureMethod", () =>
    assertReason(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">idp</saml:Issuer></samlp:Response>`,
      "missing_signature_method",
    ));
  test("rejects a Signature with no SignatureMethod while a decoy exists elsewhere (G1)", () =>
    assertReason(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
        `<saml:Extra><ds:SignatureMethod xmlns:ds="${DSIG_NS}" Algorithm="${SIG_SHA256}"/><ds:DigestMethod xmlns:ds="${DSIG_NS}" Algorithm="${DIG_SHA256}"/></saml:Extra>` +
        `<saml:Assertion ID="_a"><ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${EXC_C14N}"/><ds:Reference URI="#_a"><ds:DigestMethod Algorithm="${DIG_SHA256}"/><ds:DigestValue>x</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>x</ds:SignatureValue></ds:Signature></saml:Assertion></samlp:Response>`,
      "signature_without_method",
    ));
  test("rejects a Reference with no DigestMethod", () =>
    assertReason(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_SHA256}"/><ds:Reference URI="#_a"><ds:DigestValue>x</ds:DigestValue></ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:SignedInfo></ds:Signature></samlp:Response>`,
      "reference_without_digest",
    ));

  // ── The re-review exploits ──────────────────────────────────────────────────

  test("rejects the end-tag over-consumption exploit (rsa-sha1 hidden in a malformed end tag)", () =>
    assertRejected(base64(signedResponse(`<ds:X>y</ds:X foo <ds:SignatureMethod Algorithm="${SIG_SHA1}"/>>`))));
  test("rejects the DigestMethod end-tag variant", () =>
    assertRejected(base64(signedResponse(`<ds:X>y</ds:X foo <ds:DigestMethod Algorithm="${DIG_SHA1}"/>>`))));
  test("rejects a non-ASCII-prefixed rsa-sha1 SignatureMethod (by the allow-list)", () =>
    assertReason(
      signedResponse(`<é:SignatureMethod xmlns:é="${DSIG_NS}" Algorithm="${SIG_SHA1}"/>`),
      "signature_algorithm_not_allowed",
    ));
  test("rejects a non-ASCII-prefixed sha1 DigestMethod (by the allow-list)", () =>
    assertReason(
      signedResponse(`<é:DigestMethod xmlns:é="${DSIG_NS}" Algorithm="${DIG_SHA1}"/>`),
      "digest_algorithm_not_allowed",
    ));

  // ── Comments / CDATA / PIs / DOCTYPE / encoding ─────────────────────────────

  test("rejects a comment anywhere", () => assertReason(signedResponse(`<!-- x -->`), "comment"));
  test("rejects a CDATA section anywhere", () =>
    assertReason(signedResponse(`<saml:X xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><![CDATA[x]]></saml:X>`), "cdata"));
  test("rejects a processing instruction in the body", () =>
    assertReason(signedResponse(`<?target d?>`), "processing_instruction"));
  test("rejects a DOCTYPE", () => assertReason(`<!DOCTYPE Response>${signedResponse()}`, "doctype_or_entity"));
  test("rejects an ENTITY declaration", () => assertRejected(base64(`<!DOCTYPE x [<!ENTITY e "x">]>${signedResponse()}`)));
  test("rejects an XML declaration claiming UTF-16 over UTF-8 bytes", () =>
    assertReason(`<?xml version="1.0" encoding="UTF-16"?>${signedResponse()}`, "non_utf8_declaration"));

  // ── Encoding / base64 pre-checks ────────────────────────────────────────────

  test("rejects a non-string / empty input", () => {
    expect(assertSamlResponseAlgorithmsAllowed("")).toEqual({ ok: false, reason: "not_a_string" });
    expect(assertSamlResponseAlgorithmsAllowed(undefined)).toEqual({ ok: false, reason: "not_a_string" });
  });
  test("rejects non-base64 input", () =>
    expect(assertSamlResponseAlgorithmsAllowed("not valid base64 !!!")).toEqual({ ok: false, reason: "invalid_base64" }));
  test("rejects oversized input before decoding", () =>
    expect(assertSamlResponseAlgorithmsAllowed("A".repeat(262145))).toEqual({ ok: false, reason: "oversized" }));
  test("rejects a UTF-16-encoded document (NUL bytes)", () =>
    expect(assertSamlResponseAlgorithmsAllowed(Buffer.from(signedResponse(), "utf16le").toString("base64"))).toEqual({ ok: false, reason: "not_utf8_xml" }));

  // ── Malformed inputs xmldom 0.8.15 might recover; each must still reject ─────

  test("rejects an unclosed tag (parser reports it)", () =>
    assertReason(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><a>`, "parser_reported_problem"));
  test("rejects a mismatched end tag (parser reports it)", () =>
    assertReason(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><a></b></samlp:Response>`, "parser_reported_problem"));
  test("rejects an attribute without a value (parser reports it)", () =>
    assertReason(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><a b/></samlp:Response>`, "parser_reported_problem"));
  test("rejects an unquoted attribute value (parser reports it)", () =>
    assertReason(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><a b=c/></samlp:Response>`, "parser_reported_problem"));
  test("rejects a stray `<` in text (parser reports it)", () =>
    assertReason(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">a < b</samlp:Response>`, "parser_reported_problem"));
  test("rejects two root elements (parser reports it)", () =>
    assertReason(`<a/><b/>`, "parser_reported_problem"));
  test("rejects a two-colon element name (parser reports it)", () =>
    assertReason(signedResponse(`<a:b:SignatureMethod Algorithm="${SIG_SHA256}"/>`), "parser_reported_problem"));
  test("rejects markup (a comment) after the root (the walk catches it)", () =>
    assertReason(`${signedResponse()}<!-- x -->`, "comment"));
  test("rejects non-whitespace text before the root (the raw-text check catches it; xmldom drops it)", () =>
    assertReason(`junk${signedResponse()}`, "text_outside_root"));
  test("rejects non-whitespace text after the root (the walk catches it)", () =>
    assertReason(`${signedResponse()}trailing`, "text_outside_root"));

  // ── Cap / robustness (no crash, returns promptly) ───────────────────────────

  test("rejects a very large number of nodes by the node cap, promptly", () => {
    const many =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      "<a/>".repeat(35000) +
      `</samlp:Response>`;
    const started = Date.now();
    const result = assertSamlResponseAlgorithmsAllowed(base64(many));
    expect(result).toEqual({ ok: false, reason: "too_many_nodes" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("handles a deeply nested document without a stack overflow, promptly", () => {
    const depth = 8000;
    const deep =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      "<a>".repeat(depth) +
      "</a>".repeat(depth) +
      `</samlp:Response>`;
    const started = Date.now();
    const result = assertSamlResponseAlgorithmsAllowed(base64(deep));
    expect(result.ok).toBe(false); // too deeply nested → rejected, but must not crash
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // ── Fix round 3: hard structural limits + linear cost ───────────────────────

  test("rejects a Signature nested inside another Signature", () =>
    assertReason(
      wrap(
        `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
          `<ds:Signature><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_SHA256}"/></ds:SignedInfo></ds:Signature>` +
          `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference></ds:SignedInfo></ds:Signature>`,
      ),
      "nested_signature",
    ));
  test("rejects more than 8 sibling Signature elements", () =>
    assertReason(wrap(signatureFragment().repeat(9)), "too_many_signatures"));
  test("accepts exactly 8 sibling Signature elements", () =>
    assertOk(wrap(signatureFragment().repeat(8))));
  test("rejects more than 32 Reference elements", () => {
    const refs = `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>`.repeat(33);
    assertReason(
      wrap(`<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_SHA256}"/>${refs}</ds:SignedInfo></ds:Signature>`),
      "too_many_references",
    );
  });
  test("rejects element nesting deeper than 64", () =>
    assertReason(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
        "<a>".repeat(70) +
        "</a>".repeat(70) +
        `</samlp:Response>`,
      "too_deeply_nested",
    ));

  // Minimum over several runs: the least-preempted run is closest to true CPU
  // cost, so this stays meaningful even when the machine is loaded (e.g. another
  // full test suite running in parallel). Thresholds are deliberately generous —
  // a few seconds for an operation that is a few tens of milliseconds unloaded —
  // because the point is to catch a catastrophic (e.g. quadratic) regression, not
  // to measure wall-clock precisely; the linearity-ratio test below is the real
  // regression guard, and the structural limits above bound the work regardless.
  const timeMin = (xml: string, runs = 9): number => {
    const input = base64(xml);
    assertSamlResponseAlgorithmsAllowed(input); // warm up
    let best = Infinity;
    for (let i = 0; i < runs; i += 1) {
      const started = process.hrtime.bigint();
      assertSamlResponseAlgorithmsAllowed(input);
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
  };
  const PROMPT_MS = 6000;

  // 8 valid signatures sharing 32 references, plus filler to approach the size cap
  // — the heaviest shape the limits permit; the single linear pass must stay fast.
  function limitedHeavy(filler: number): string {
    let signatures = "";
    for (let s = 0; s < 8; s += 1) {
      let references = "";
      for (let r = 0; r < 4; r += 1) {
        references += `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>`;
      }
      signatures += `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_SHA256}"/>${references}</ds:SignedInfo></ds:Signature>`;
    }
    return (
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      signatures +
      "<x/>".repeat(filler) +
      `</samlp:Response>`
    );
  }

  test("the 764-nested-signatures DoS input is rejected promptly", () => {
    const nested =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignatureMethod Algorithm="${SIG_SHA256}"/><ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>`.repeat(764) +
      `</ds:Signature>`.repeat(764) +
      `</samlp:Response>`;
    expect(assertSamlResponseAlgorithmsAllowed(base64(nested))).toEqual({
      ok: false,
      reason: "nested_signature",
    });
    expect(timeMin(nested)).toBeLessThan(PROMPT_MS);
  });

  test("the heaviest limit-respecting accepted shape returns promptly", () => {
    const heavy = limitedHeavy(12000); // ~12k filler nodes, under the node + size caps
    expect(assertSamlResponseAlgorithmsAllowed(base64(heavy))).toEqual({ ok: true });
    expect(timeMin(heavy)).toBeLessThan(PROMPT_MS);
  });

  test("max sibling signatures, deepest tree and max tiny elements all return promptly", () => {
    const maxSiblings = wrap(signatureFragment().repeat(9)); // rejected too_many_signatures
    const deepest =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      "<a>".repeat(5000) +
      "</a>".repeat(5000) +
      `</samlp:Response>`; // rejected too_deeply_nested (deep parse, early reject)
    const manyTiny =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      "<x/>".repeat(31000) +
      `</samlp:Response>`; // rejected too_many_nodes
    const manyAttributes = (() => {
      let attrs = "";
      for (let i = 0; i < 6000; i += 1) {
        attrs += ` a${i}="x"`;
      }
      return wrap(
        `<ds:Signature xmlns:ds="${DSIG_NS}"><ds:SignedInfo><ds:SignatureMethod${attrs} Algorithm="${SIG_SHA256}"/><ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference></ds:SignedInfo></ds:Signature>`,
      );
    })();
    for (const xml of [maxSiblings, deepest, manyTiny]) {
      expect(assertSamlResponseAlgorithmsAllowed(base64(xml)).ok).toBe(false);
      expect(timeMin(xml)).toBeLessThan(PROMPT_MS);
    }
    // Many attributes on one SignatureMethod is a VALID (accepted) signature; the
    // bounded attribute scan must still stay fast.
    expect(assertSamlResponseAlgorithmsAllowed(base64(manyAttributes))).toEqual({ ok: true });
    expect(timeMin(manyAttributes)).toBeLessThan(PROMPT_MS);
  });

  test("cost scales roughly linearly (N vs 2N well below quadratic)", () => {
    const small = limitedHeavy(5000);
    const large = limitedHeavy(10000);
    expect(assertSamlResponseAlgorithmsAllowed(base64(small))).toEqual({ ok: true });
    expect(assertSamlResponseAlgorithmsAllowed(base64(large))).toEqual({ ok: true });
    // min-over-runs keeps the ratio meaningful under load; linear ≈ 2×, quadratic ≈ 4×.
    const ratio = timeMin(large) / Math.max(timeMin(small), 0.5);
    expect(ratio).toBeLessThan(4);
  });

  // ── Fix round 3 (b): a single leading XML declaration only ──────────────────

  test("rejects a second XML declaration", () =>
    assertReason(`<?xml version="1.0"?><?xml version="1.0"?>${signedResponse()}`, "processing_instruction"));
  test("rejects a mid-document XML declaration", () =>
    assertReason(signedResponse(`<?xml version="1.0"?>`), "processing_instruction"));
});
