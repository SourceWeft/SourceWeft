import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import * as samlify from "samlify";

/**
 * A throwaway SAML identity provider for the enterprise-SSO database tests. It
 * mints the SAML Responses that `@better-auth/sso`'s Assertion Consumer Service
 * (`POST /sso/saml2/sp/acs/:providerId`) consumes, so the SAML sign-in flow can
 * be exercised end to end — the happy path and every security rejection — against
 * a real database, with no network access and no real DNS.
 *
 * All crypto is in-process and test-only:
 *  - RSA key pairs come from `node:crypto` at fixture construction;
 *  - a self-signed X.509 certificate is built from each key pair by
 *    {@link selfSignedCertificate} (Node has no certificate-minting API, and no
 *    dependency is added for one), so no static key material is embedded in the
 *    repository for secret scanners to flag;
 *  - Assertions are signed with `samlify`'s own `constructSAMLSignature` — the
 *    same routine the library uses internally — so a validly signed Response is
 *    accepted by the plugin's `samlify`-backed verification exactly as a real
 *    IdP's would be.
 *
 * `samlify` is a dev-only dependency pinned to the exact version `@better-auth/sso`
 * resolves (2.15.1). The plugin installs the module-global `setSchemaValidator`
 * when it is imported, and `samlify` is a singleton, so the Responses this fixture
 * produces are parsed by the ACS under the plugin's own validator.
 */

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const NAMEID_FORMAT_EMAIL =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const BEARER_METHOD = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const ATTR_NAME_FORMAT = "urn:oasis:names:tc:SAML:2.0:attrname-format:basic";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

/** Signature algorithm URIs the IdP can sign with. RSA-SHA1 is deprecated. */
export const SAML_SIGNATURE_ALGORITHMS = {
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  rsaSha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
} as const;

/** How (and whether) the fixture signs a Response. */
export type SamlSigningMode = "assertion" | "message" | "none";

export type SamlResponseInput = {
  /** The SP ACS URL: the Response `Destination` and the bearer `Recipient`. */
  acsUrl: string;
  /** The `AudienceRestriction` audience (the SP entity ID in the happy path). */
  audience: string;
  /** The AuthnRequest ID to answer. Omitted makes the Response IdP-initiated. */
  inResponseTo?: string;
  /** The Subject `NameID`; also the SSO account id the plugin keys on. */
  nameId: string;
  /** The email the IdP asserts (sent as an `email` attribute). */
  email: string;
  /** Extra SAML attributes (e.g. `{ groups: ["sw-admins"] }`). */
  attributes?: Record<string, string[]>;
  /** What the signature covers. Defaults to the assertion. */
  sign?: SamlSigningMode;
  /** The signing algorithm URI. Defaults to RSA-SHA256. */
  signatureAlgorithm?: string;
  /**
   * Overwrite the signed response's `DigestMethod` Algorithm after signing (so
   * the signature no longer matches). Used to exercise a response whose signature
   * algorithm is allowed but whose digest algorithm is not — the guard rejects it
   * on the declared algorithm, before any signature check.
   */
  digestAlgorithmOverride?: string;
  /** `Conditions`/bearer `NotOnOrAfter`. Defaults to five minutes ahead. */
  notOnOrAfter?: Date;
  /** `Conditions`/bearer `NotBefore`. Defaults to one minute ago. */
  notBefore?: Date;
  /** Drop both timestamp attributes from `Conditions` (keep the bearer one). */
  omitConditionTimestamps?: boolean;
  /** Override the Response `Destination` (to point at a different ACS). */
  destination?: string;
  /** Override the bearer `Recipient` (to point at a different ACS). */
  recipient?: string;
  /** Sign with the registered key (`idp`) or an unrelated key (`rogue`). */
  signWith?: "idp" | "rogue";
  /**
   * Inject a second, unsigned Assertion carrying a different identity before the
   * signed one (an XML signature-wrapping attempt). The Response then holds two
   * Assertions.
   */
  injectedAssertion?: { nameId: string; email: string };
};

export type SamlIdpFixture = {
  /** The IdP entity ID (the `Issuer` of every Response). */
  entityId: string;
  /** The IdP Single Sign-On URL, for the provider's `entryPoint`. */
  entryPoint: string;
  /** The IdP signing certificate (PEM), for `idpMetadata.cert`. */
  cert: string;
  /** IdP metadata XML carrying the signing certificate, for `idpMetadata.metadata`. */
  metadataXml: string;
  /** Build a base64-encoded `SAMLResponse` for the ACS form POST. */
  buildResponse(input: SamlResponseInput): string;
};

// ── Minimal DER encoder, just enough for a self-signed X.509 certificate ──────

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** DER INTEGER from a non-negative JS integer. */
function derInteger(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  if (remaining === 0) {
    bytes.push(0);
  }
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  let buffer = Buffer.from(bytes);
  // A leading high bit would read as a negative number; prefix a zero byte.
  if (buffer[0]! & 0x80) {
    buffer = Buffer.concat([Buffer.from([0]), buffer]);
  }
  return der(0x02, buffer);
}

function derOid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const first = 40 * parts[0]! + parts[1]!;
  const bytes = [first];
  for (let i = 2; i < parts.length; i++) {
    let value = parts[i]!;
    const stack = [value & 0x7f];
    value >>= 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

const derNull = (): Buffer => der(0x05, Buffer.alloc(0));
const derSequence = (...items: Buffer[]): Buffer => der(0x30, Buffer.concat(items));
const derSet = (...items: Buffer[]): Buffer => der(0x31, Buffer.concat(items));
const derBitString = (content: Buffer): Buffer =>
  der(0x03, Buffer.concat([Buffer.from([0]), content]));
const derExplicit = (tagNumber: number, content: Buffer): Buffer =>
  der(0xa0 | tagNumber, content);

function derUtcTime(date: Date): Buffer {
  // YYMMDDHHMMSSZ (valid for years 1950–2049; the fixture stays well inside it).
  const text = `${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_COMMON_NAME = "2.5.4.3";

const sha256WithRsaAlgorithmId = (): Buffer =>
  derSequence(derOid(OID_SHA256_WITH_RSA), derNull());

const distinguishedName = (commonName: string): Buffer =>
  derSequence(
    derSet(
      derSequence(derOid(OID_COMMON_NAME), der(0x13, Buffer.from(commonName, "ascii"))),
    ),
  );

/**
 * Build a self-signed X.509 (v3) certificate PEM for `publicKey`, signed with
 * `privateKey` (SHA-256/RSA). TEST-ONLY: minimal fields, a far-future validity
 * window, and keys generated per run — never a real credential.
 */
function selfSignedCertificate(
  privateKey: KeyObject,
  publicKey: KeyObject,
  commonName: string,
): string {
  const subjectPublicKeyInfo = publicKey.export({ type: "spki", format: "der" });
  const name = distinguishedName(commonName);
  const tbsCertificate = derSequence(
    derExplicit(0, derInteger(2)), // version v3
    derInteger(Math.floor(Math.random() * 0x7fffffff) + 1), // serialNumber
    sha256WithRsaAlgorithmId(),
    name, // issuer
    derSequence(
      derUtcTime(new Date("2020-01-01T00:00:00Z")),
      derUtcTime(new Date("2037-01-01T00:00:00Z")),
    ),
    name, // subject
    subjectPublicKeyInfo,
  );
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = derSequence(
    tbsCertificate,
    sha256WithRsaAlgorithmId(),
    derBitString(signature),
  );
  const body = certificate.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

// ── SAML Response assembly ────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attribute(name: string, value: string): string {
  return ` ${name}="${escapeXml(value)}"`;
}

function optionalAttribute(name: string, value: string | undefined): string {
  return value === undefined ? "" : attribute(name, value);
}

function attributeStatement(
  attributes: Record<string, string[]> | undefined,
): string {
  if (!attributes || Object.keys(attributes).length === 0) {
    return "";
  }
  const entries = Object.entries(attributes)
    .map(([name, values]) => {
      const valueElements = values
        .map(
          (value) =>
            `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escapeXml(value)}</saml:AttributeValue>`,
        )
        .join("");
      return `<saml:Attribute Name="${escapeXml(name)}" NameFormat="${ATTR_NAME_FORMAT}">${valueElements}</saml:Attribute>`;
    })
    .join("");
  return `<saml:AttributeStatement>${entries}</saml:AttributeStatement>`;
}

function assertionXml(input: {
  assertionId: string;
  issuer: string;
  issueInstant: string;
  nameId: string;
  email: string;
  audience: string;
  acsRecipient: string;
  inResponseTo: string | undefined;
  notBefore: string;
  notOnOrAfter: string;
  omitConditionTimestamps: boolean;
  attributes: Record<string, string[]> | undefined;
}): string {
  const subjectConfirmationData =
    `<saml:SubjectConfirmationData${attribute("NotOnOrAfter", input.notOnOrAfter)}` +
    `${attribute("Recipient", input.acsRecipient)}` +
    `${optionalAttribute("InResponseTo", input.inResponseTo)}/>`;
  const conditionsTimestamps = input.omitConditionTimestamps
    ? ""
    : `${attribute("NotBefore", input.notBefore)}${attribute("NotOnOrAfter", input.notOnOrAfter)}`;
  const emailAttributes = { email: [input.email], ...input.attributes };
  return (
    `<saml:Assertion xmlns:saml="${SAML_ASSERTION_NS}"${attribute("ID", input.assertionId)} Version="2.0"${attribute("IssueInstant", input.issueInstant)}>` +
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${NAMEID_FORMAT_EMAIL}">${escapeXml(input.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${BEARER_METHOD}">${subjectConfirmationData}</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions${conditionsTimestamps}>` +
    `<saml:AudienceRestriction><saml:Audience>${escapeXml(input.audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement${attribute("AuthnInstant", input.issueInstant)} SessionIndex="${escapeXml(input.assertionId)}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    attributeStatement(emailAttributes) +
    `</saml:Assertion>`
  );
}

export function createSamlIdpFixture(): SamlIdpFixture {
  const suffix = randomUUID();
  const entityId = `https://idp.saml.test/${suffix}`;
  const entryPoint = `${entityId}/sso`;

  const idpKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const idpPrivateKeyPem = idpKeyPair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const idpCert = selfSignedCertificate(
    idpKeyPair.privateKey,
    idpKeyPair.publicKey,
    "TEST-ONLY SAML IdP",
  );

  // An unrelated key pair + certificate, for the "signed by a different key than
  // the registered certificate" rejection.
  const rogueKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const roguePrivateKeyPem = rogueKeyPair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const rogueCert = selfSignedCertificate(
    rogueKeyPair.privateKey,
    rogueKeyPair.publicKey,
    "TEST-ONLY ROGUE IdP",
  );

  const metadataXml = samlify
    .IdentityProvider({
      entityID: entityId,
      singleSignOnService: [{ Binding: REDIRECT_BINDING, Location: entryPoint }],
      signingCert: idpCert,
    })
    .getMetadata();

  function sign_(
    rawXml: string,
    mode: Exclude<SamlSigningMode, "none">,
    signatureAlgorithm: string,
    privateKeyPem: string,
    certPem: string,
  ): string {
    const referenceTagXPath =
      mode === "assertion"
        ? "/*[local-name(.)='Response']/*[local-name(.)='Assertion']"
        : "/*[local-name(.)='Response']";
    const signatureLocationReference =
      mode === "assertion"
        ? "/*[local-name(.)='Response']/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']"
        : "/*[local-name(.)='Response']/*[local-name(.)='Issuer']";
    return samlify.SamlLib.constructSAMLSignature({
      rawSamlMessage: rawXml,
      referenceTagXPath,
      privateKey: privateKeyPem,
      // samlify reads the signing cert as a bare base64 DER body (no PEM armor).
      signingCert: samlify.Utility.toCertificateBody(certPem),
      signatureAlgorithm,
      isBase64Output: false,
      signatureConfig: {
        prefix: "ds",
        location: { reference: signatureLocationReference, action: "after" },
      },
    });
  }

  function buildResponse(input: SamlResponseInput): string {
    const now = new Date();
    const notBefore = (input.notBefore ?? new Date(now.getTime() - 60_000)).toISOString();
    const notOnOrAfter = (
      input.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)
    ).toISOString();
    const issueInstant = now.toISOString();
    const destination = input.destination ?? input.acsUrl;
    const recipient = input.recipient ?? input.acsUrl;

    const signedAssertion = assertionXml({
      assertionId: `_assert-${randomUUID()}`,
      issuer: entityId,
      issueInstant,
      nameId: input.nameId,
      email: input.email,
      audience: input.audience,
      acsRecipient: recipient,
      inResponseTo: input.inResponseTo,
      notBefore,
      notOnOrAfter,
      omitConditionTimestamps: input.omitConditionTimestamps ?? false,
      attributes: input.attributes,
    });

    const responseXml =
      `<samlp:Response xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_ASSERTION_NS}"` +
      `${attribute("ID", `_resp-${randomUUID()}`)} Version="2.0"${attribute("IssueInstant", issueInstant)}` +
      `${attribute("Destination", destination)}${optionalAttribute("InResponseTo", input.inResponseTo)}>` +
      `<saml:Issuer>${escapeXml(entityId)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="${STATUS_SUCCESS}"/></samlp:Status>` +
      signedAssertion +
      `</samlp:Response>`;

    const mode = input.sign ?? "assertion";
    const signatureAlgorithm =
      input.signatureAlgorithm ?? SAML_SIGNATURE_ALGORITHMS.rsaSha256;
    const useRogue = input.signWith === "rogue";
    const privateKeyPem = useRogue ? roguePrivateKeyPem : idpPrivateKeyPem;
    const certPem = useRogue ? rogueCert : idpCert;

    let finalXml =
      mode === "none"
        ? responseXml
        : sign_(responseXml, mode, signatureAlgorithm, privateKeyPem, certPem);

    if (input.digestAlgorithmOverride !== undefined) {
      const override = input.digestAlgorithmOverride;
      finalXml = finalXml.replace(
        /(<(?:[A-Za-z_][\w.-]*:)?DigestMethod[^>]*\bAlgorithm=")[^"]*(")/,
        `$1${override}$2`,
      );
    }

    if (input.injectedAssertion) {
      // Splice a second, unsigned Assertion in front of the (already signed) one.
      // The genuine assertion's enveloped signature stays valid over its own
      // subtree; the Response now carries two Assertions.
      const injected = assertionXml({
        assertionId: `_injected-${randomUUID()}`,
        issuer: entityId,
        issueInstant,
        nameId: input.injectedAssertion.nameId,
        email: input.injectedAssertion.email,
        audience: input.audience,
        acsRecipient: recipient,
        inResponseTo: input.inResponseTo,
        notBefore,
        notOnOrAfter,
        omitConditionTimestamps: input.omitConditionTimestamps ?? false,
        attributes: input.attributes,
      });
      const marker = "<saml:Assertion";
      const at = finalXml.indexOf(marker);
      finalXml = `${finalXml.slice(0, at)}${injected}${finalXml.slice(at)}`;
    }

    return Buffer.from(finalXml, "utf8").toString("base64");
  }

  return { entityId, entryPoint, cert: idpCert, metadataXml, buildResponse };
}
