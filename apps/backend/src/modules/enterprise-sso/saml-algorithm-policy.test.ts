import { describe, expect, test } from "vitest";
import { assertSamlResponseAlgorithmsAllowed } from "./saml-algorithm-policy";

const SIG_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SIG_SHA512 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512";
const SIG_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const DIG_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const DIG_SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";

function base64(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

/** A SignedInfo carrying the given raw SignatureMethod / DigestMethod tags. */
function signedInfo(signatureMethod: string, digestMethod: string): string {
  return (
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
    `${signatureMethod}<ds:Reference>${digestMethod}</ds:Reference>` +
    `</ds:SignedInfo><ds:SignatureValue>AA==</ds:SignatureValue></ds:Signature>`
  );
}

/** A minimal signed SAML Response around `inner` assertion content. */
function response(inner: string): string {
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
    `<saml:Assertion ID="_a">${inner}<saml:Subject><saml:NameID>a@b.com</saml:NameID></saml:Subject></saml:Assertion>` +
    `</samlp:Response>`
  );
}

function sig(algorithm: string, attrs = ""): string {
  return `<ds:SignatureMethod${attrs} Algorithm="${algorithm}"/>`;
}
function digest(algorithm: string): string {
  return `<ds:DigestMethod Algorithm="${algorithm}"/>`;
}

/** The standard happy-path response: rsa-sha256 signature, sha256 digest. */
function okResponse(): string {
  return response(signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)));
}

function assertOk(xml: string): void {
  const result = assertSamlResponseAlgorithmsAllowed(base64(xml));
  expect(result).toEqual({ ok: true });
}

function assertRejected(input: string): void {
  const result = assertSamlResponseAlgorithmsAllowed(input);
  expect(result.ok).toBe(false);
}

describe("assertSamlResponseAlgorithmsAllowed", () => {
  test("accepts an rsa-sha256 signature with a sha256 digest", () => {
    assertOk(okResponse());
  });

  test("accepts rsa-sha512 with sha512 digest", () => {
    assertOk(
      response(
        signedInfo(
          sig(SIG_SHA512),
          digest("http://www.w3.org/2001/04/xmlenc#sha512"),
        ),
      ),
    );
  });

  test("rejects an rsa-sha1 SignatureMethod", () => {
    assertRejected(base64(response(signedInfo(sig(SIG_SHA1), digest(DIG_SHA256)))));
  });

  test("rejects a sha1 DigestMethod even with an rsa-sha256 signature", () => {
    assertRejected(base64(response(signedInfo(sig(SIG_SHA256), digest(DIG_SHA1)))));
  });

  test("rejects two signatures where the second uses rsa-sha1", () => {
    const first = signedInfo(sig(SIG_SHA256), digest(DIG_SHA256));
    const second = signedInfo(sig(SIG_SHA1), digest(DIG_SHA256));
    assertRejected(base64(response(first + second)));
  });

  test("rejects an Algorithm value written with a character reference", () => {
    assertRejected(
      base64(response(signedInfo(sig("rsa-sha&#49;"), digest(DIG_SHA256)))),
    );
  });

  test("rejects the exact SHA-256 URI with one character entity-encoded", () => {
    // Decodes to the allowed URI, but the `&` is fail-closed-rejected before decoding.
    const encoded = "http://www.w3.org/2001/04/xmldsig-more#&#114;sa-sha256";
    assertRejected(base64(response(signedInfo(sig(encoded), digest(DIG_SHA256)))));
  });

  test("accepts an allowed URI quoted with single quotes", () => {
    const xml = response(
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
        `<ds:SignatureMethod Algorithm='${SIG_SHA256}'/>` +
        `<ds:Reference><ds:DigestMethod Algorithm='${DIG_SHA256}'/></ds:Reference>` +
        `</ds:SignedInfo></ds:Signature>`,
    );
    assertOk(xml);
  });

  test("rejects a method carrying only a lower-case `algorithm` attribute", () => {
    assertRejected(
      base64(
        response(signedInfo(sig(SIG_SHA256, "").replace("Algorithm", "algorithm"), digest(DIG_SHA256))),
      ),
    );
  });

  test("accepts a `>` inside a quoted attribute value of the method tag (quote-aware end)", () => {
    // The `>` is inside a quoted value, so the tag's real end is after it.
    const method = `<ds:SignatureMethod Foo="a>b" Algorithm="${SIG_SHA256}"/>`;
    assertOk(response(signedInfo(method, digest(DIG_SHA256))));
  });

  test("a `>` in a quoted attribute of an unrelated element does not hide a following SHA-1 SignatureMethod", () => {
    const xml = response(
      `<saml:Attribute Name="x>y"></saml:Attribute>` +
        signedInfo(sig(SIG_SHA1), digest(DIG_SHA256)),
    );
    assertRejected(base64(xml));
  });

  test("accepts unprefixed and differently-prefixed SignatureMethod/DigestMethod names", () => {
    const xml = response(
      `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>` +
        `<SignatureMethod Algorithm="${SIG_SHA256}"/>` +
        `<Reference><DigestMethod Algorithm="${DIG_SHA256}"/></Reference>` +
        `</SignedInfo></Signature>`,
    );
    assertOk(xml);
    const prefixed = response(
      `<dsig:Signature xmlns:dsig="http://www.w3.org/2000/09/xmldsig#"><dsig:SignedInfo>` +
        `<dsig:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
        `<dsig:Reference><dsig:DigestMethod Algorithm="${DIG_SHA256}"/></dsig:Reference>` +
        `</dsig:SignedInfo></dsig:Signature>`,
    );
    assertOk(prefixed);
  });

  test("rejects a response with no SignatureMethod at all", () => {
    const result = assertSamlResponseAlgorithmsAllowed(
      base64(response("<saml:Issuer>idp</saml:Issuer>")),
    );
    expect(result).toEqual({ ok: false, reason: "missing_signature_method" });
  });

  test("rejects a signature with no DigestMethod", () => {
    const xml = response(
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
        `<ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
        `</ds:SignedInfo></ds:Signature>`,
    );
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "missing_digest_method",
    });
  });

  test("rejects a document with a DOCTYPE", () => {
    const xml = `<!DOCTYPE Response>${okResponse()}`;
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "doctype_or_entity",
    });
  });

  test("rejects a document declaring an ENTITY", () => {
    const xml = `<!DOCTYPE x [<!ENTITY e "x">]>${okResponse()}`;
    assertRejected(base64(xml));
  });

  test("rejects a response containing an EncryptedAssertion", () => {
    const xml = response(
      signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)) +
        `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="x"/></saml:EncryptedAssertion>`,
    );
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "encrypted_assertion",
    });
  });

  test("rejects a bare EncryptedData element", () => {
    const xml = response(
      signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)) + `<xenc:EncryptedData xmlns:xenc="x"/>`,
    );
    assertRejected(base64(xml));
  });

  test("rejects non-base64 input", () => {
    expect(assertSamlResponseAlgorithmsAllowed("not valid base64 !!!")).toEqual({
      ok: false,
      reason: "invalid_base64",
    });
  });

  test("rejects an empty / non-string input", () => {
    expect(assertSamlResponseAlgorithmsAllowed("")).toEqual({
      ok: false,
      reason: "not_a_string",
    });
    expect(assertSamlResponseAlgorithmsAllowed(undefined)).toEqual({
      ok: false,
      reason: "not_a_string",
    });
  });

  test("rejects oversized input before decoding", () => {
    const oversized = "A".repeat(262145);
    expect(assertSamlResponseAlgorithmsAllowed(oversized)).toEqual({
      ok: false,
      reason: "oversized",
    });
  });

  test("rejects a UTF-16-encoded document", () => {
    const utf16 = Buffer.from(okResponse(), "utf16le").toString("base64");
    expect(assertSamlResponseAlgorithmsAllowed(utf16)).toEqual({
      ok: false,
      reason: "not_utf8_xml",
    });
  });

  test("rejects an allowed URI with a trailing space (no normalisation)", () => {
    assertRejected(
      base64(response(signedInfo(sig(`${SIG_SHA256} `), digest(DIG_SHA256)))),
    );
  });

  test("rejects an allowed URI in a different case (no case folding)", () => {
    assertRejected(
      base64(
        response(signedInfo(sig(SIG_SHA256.toUpperCase()), digest(DIG_SHA256))),
      ),
    );
  });

  test("fail-closed: a SHA-1 SignatureMethod inside an XML comment is still rejected", () => {
    const xml = response(
      `<!-- ${sig(SIG_SHA1)} -->` +
        signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)),
    );
    assertRejected(base64(xml));
  });

  test("fail-closed: a SHA-1 SignatureMethod inside a CDATA section is still rejected", () => {
    const xml = response(
      `<saml:AttributeValue><![CDATA[ ${sig(SIG_SHA1)} ]]></saml:AttributeValue>` +
        signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)),
    );
    assertRejected(base64(xml));
  });

  // ── Fix round 1: markup tokenisation (non-ASCII-prefix bypass and kin) ──────

  test("rejects the reviewer's bypass: a non-ASCII-prefixed rsa-sha1 SignatureMethod first, ASCII rsa-sha256 decoy after", () => {
    const xml = response(
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
        `<é:SignatureMethod xmlns:é="http://www.w3.org/2000/09/xmldsig#" Algorithm="${SIG_SHA1}"/>` +
        `<ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
        `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>` +
        `</ds:SignedInfo></ds:Signature>`,
    );
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "tag_name_not_ncname",
    });
  });

  test("rejects the DigestMethod variant of the bypass (non-ASCII prefix via a second Reference)", () => {
    const xml = response(
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
        `<ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
        `<ds:Reference><é:DigestMethod xmlns:é="http://www.w3.org/2000/09/xmldsig#" Algorithm="${DIG_SHA1}"/></ds:Reference>` +
        `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>` +
        `</ds:SignedInfo></ds:Signature>`,
    );
    assertRejected(base64(xml));
  });

  test("rejects a non-ASCII prefix even when the algorithm is allowed (the name rule rejects first)", () => {
    const xml = response(
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
        `<é:SignatureMethod xmlns:é="http://www.w3.org/2000/09/xmldsig#" Algorithm="${SIG_SHA256}"/>` +
        `<ds:Reference><ds:DigestMethod Algorithm="${DIG_SHA256}"/></ds:Reference>` +
        `</ds:SignedInfo></ds:Signature>`,
    );
    assertRejected(base64(xml));
  });

  test("rejects an element name with two colons", () => {
    assertRejected(
      base64(response(signedInfo(`<a:b:SignatureMethod Algorithm="${SIG_SHA256}"/>`, digest(DIG_SHA256)))),
    );
  });

  test("rejects a comment anywhere in the document", () => {
    const xml = response(`<!-- hi -->` + signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)));
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "comment",
    });
  });

  test("rejects a CDATA section anywhere in the document", () => {
    const xml = response(
      `<saml:X><![CDATA[hi]]></saml:X>` + signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)),
    );
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "cdata",
    });
  });

  test("rejects a processing instruction in the body", () => {
    const xml = response(`<?target data?>` + signedInfo(sig(SIG_SHA256), digest(DIG_SHA256)));
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "processing_instruction",
    });
  });

  test("rejects an XML declaration claiming UTF-16 over UTF-8 bytes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-16"?>${okResponse()}`;
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "non_utf8_declaration",
    });
  });

  test("accepts a valid response with an explicit UTF-8 XML declaration", () => {
    assertOk(`<?xml version="1.0" encoding="UTF-8"?>${okResponse()}`);
  });

  test("accepts a valid response with a leading BOM and an XML declaration", () => {
    assertOk(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>${okResponse()}`);
  });

  test("rejects an unterminated tag with an unbalanced quote", () => {
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<foo bar="unclosed/></samlp:Response>`;
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "unbalanced_quote",
    });
  });

  test("rejects a lower-case `signaturemethod` element (suspicious variant)", () => {
    const xml = response(
      `<ds:signaturemethod Algorithm="${SIG_SHA256}"/><ds:DigestMethod Algorithm="${DIG_SHA256}"/>`,
    );
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "suspicious_element_variant",
    });
  });

  test("rejects a SignatureMethod carrying only a prefixed `ds:Algorithm` attribute", () => {
    assertRejected(
      base64(
        response(signedInfo(`<ds:SignatureMethod ds:Algorithm="${SIG_SHA256}"/>`, digest(DIG_SHA256))),
      ),
    );
  });

  test("rejects a SignatureMethod with two Algorithm attributes", () => {
    assertRejected(
      base64(
        response(
          signedInfo(
            `<ds:SignatureMethod Algorithm="${SIG_SHA256}" Algorithm="${SIG_SHA1}"/>`,
            digest(DIG_SHA256),
          ),
        ),
      ),
    );
  });

  // ── Self-break attempts (parser differential vs xmldom/xml-crypto) ──────────
  // Each records an attempt to make the raw scan disagree with the real verifier.
  // Accepted values are exact allow-listed URIs only, which carry no whitespace,
  // so XML attribute-value normalisation (tab/newline → space) cannot turn an
  // accepted value into a different one for xml-crypto.

  test("rejects a newline inside an Algorithm value (raw read, no attribute normalisation)", () => {
    assertRejected(
      base64(response(signedInfo(`<ds:SignatureMethod Algorithm="${SIG_SHA256}\n"/>`, digest(DIG_SHA256)))),
    );
  });

  test("rejects a tab inside an Algorithm value", () => {
    assertRejected(
      base64(response(signedInfo(`<ds:SignatureMethod Algorithm="${SIG_SHA256}\t"/>`, digest(DIG_SHA256)))),
    );
  });

  test("rejects whitespace between `<` and the element name", () => {
    assertRejected(
      base64(response(signedInfo(`< ds:SignatureMethod Algorithm="${SIG_SHA256}"/>`, digest(DIG_SHA256)))),
    );
  });

  test("rejects an unquoted Algorithm value", () => {
    assertRejected(
      base64(response(signedInfo(`<ds:SignatureMethod Algorithm=${SIG_SHA256}/>`, digest(DIG_SHA256)))),
    );
  });

  test("accepts a SignatureMethod in a redeclared default namespace", () => {
    assertOk(
      response(
        `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>` +
          `<SignatureMethod Algorithm="${SIG_SHA256}"/>` +
          `<Reference><DigestMethod Algorithm="${DIG_SHA256}"/></Reference>` +
          `</SignedInfo></Signature>`,
      ),
    );
  });

  test("rejects a tag left unterminated at end of input", () => {
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<ds:SignatureMethod Algorithm="${SIG_SHA256}"`;
    expect(assertSamlResponseAlgorithmsAllowed(base64(xml))).toEqual({
      ok: false,
      reason: "unterminated_tag",
    });
  });

  test("accepts a realistic Okta/Entra/Keycloak-shape response (two signatures, KeyInfo, c14n, Transforms, &amp; in a URL)", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" Destination="https://sp.example.com/acs?foo=1&amp;bar=2" ID="_resp" Version="2.0">` +
      `<saml2:Issuer>https://idp.example.com</saml2:Issuer>` +
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
      `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"><ec:InclusiveNamespaces xmlns:ec="http://www.w3.org/2001/10/xml-exc-c14n#" PrefixList="saml2p saml2"/></ds:CanonicalizationMethod>` +
      `<ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
      `<ds:Reference URI="#_resp"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:Transforms><ds:DigestMethod Algorithm="${DIG_SHA256}"/><ds:DigestValue>abcd==</ds:DigestValue></ds:Reference>` +
      `</ds:SignedInfo><ds:SignatureValue>c2ln</ds:SignatureValue>` +
      `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIICdummy==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>` +
      `<saml2:Assertion ID="_a" Version="2.0"><saml2:Issuer>https://idp.example.com</saml2:Issuer>` +
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>` +
      `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `<ds:SignatureMethod Algorithm="${SIG_SHA256}"/>` +
      `<ds:Reference URI="#_a"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms><ds:DigestMethod Algorithm="${DIG_SHA256}"/><ds:DigestValue>ef==</ds:DigestValue></ds:Reference>` +
      `</ds:SignedInfo><ds:SignatureValue>c2ln</ds:SignatureValue></ds:Signature>` +
      `<saml2:Subject><saml2:NameID>user@example.com</saml2:NameID></saml2:Subject></saml2:Assertion></saml2p:Response>`;
    assertOk(xml);
  });
});
