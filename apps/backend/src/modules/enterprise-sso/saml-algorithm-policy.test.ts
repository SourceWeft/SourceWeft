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

  test("rejects a `>` inside another attribute before Algorithm (truncated tag)", () => {
    const method = `<ds:SignatureMethod Foo="a>b" Algorithm="${SIG_SHA256}"/>`;
    assertRejected(base64(response(signedInfo(method, digest(DIG_SHA256)))));
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
});
