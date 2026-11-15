import type { Metadata } from "next";
import Link from "next/link";
import {
  BulletList,
  Code,
  DataTable,
  Note,
  Section,
  SubSection,
} from "../cli/parts";

export const metadata: Metadata = {
  title: "Single sign-on (SSO) | SourceWeft Docs",
  description:
    "Set up OIDC or SAML single sign-on for your SourceWeft team: register an identity provider, verify your email domain, map roles, and let members sign in with their work account.",
};

const CONTENTS = [
  ["what-it-is", "What it does and who can set it up"],
  ["prerequisites", "Before you start"],
  ["setup", "Set up a provider"],
  ["idps", "Notes for specific identity providers"],
  ["roles", "Role mapping"],
  ["first-sign-in", "What happens on first sign-in"],
  ["troubleshooting", "Troubleshooting"],
  ["security", "Security"],
  ["limitations", "What is not supported yet"],
] as const;

export default function SsoPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
      <nav className="mb-10 text-sm opacity-70">
        <Link href="/" className="hover:underline">
          SourceWeft Docs
        </Link>{" "}
        / Single sign-on
      </nav>

      <header className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold tracking-tight">
          Single sign-on (SSO)
        </h1>
        <p className="text-lg leading-8 opacity-80">
          Single sign-on lets the members of a team sign in to SourceWeft
          through your own identity provider, with the account they already use
          at work. SourceWeft supports both <strong>OIDC</strong> and{" "}
          <strong>SAML 2.0</strong> identity providers.
        </p>
        <p className="leading-7">
          Single sign-on belongs to a <strong>team</strong>. You connect an
          identity provider to one email domain you control, verify that you own
          the domain, and from then on anyone with an address on that domain can
          sign in with it. Only a team <strong>owner</strong> or{" "}
          <strong>admin</strong> can set it up — in the team&rsquo;s settings,
          under the <Code>Single sign-on</Code> tab. It is not available for
          personal organizations.
        </p>
      </header>

      <nav
        aria-label="On this page"
        className="mt-8 rounded-lg border border-neutral-300 p-4 text-sm dark:border-neutral-800"
      >
        <p className="mb-2 font-semibold">On this page</p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {CONTENTS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="hover:underline">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="what-it-is" title="What it does and who can set it up">
        <p>
          Once a provider is connected and its domain is verified, members sign
          in without a SourceWeft password. On the sign-in page they choose{" "}
          <Code>Sign in with SSO</Code>, enter their work email, and are sent to
          your identity provider; when they come back they are signed in. A
          first-time member is created and added to your team automatically.
        </p>
        <BulletList>
          <li>
            <strong>Who can configure it:</strong> a team owner or admin. Other
            members do not see the settings.
          </li>
          <li>
            <strong>Where it works:</strong> teams only. The option does not
            appear for a personal organization.
          </li>
          <li>
            <strong>How members reach it:</strong> the{" "}
            <Code>Sign in with SSO</Code> button on the normal sign-in page, or
            a direct link you can share (below). The desktop and browser
            extension sign-ins go through the same browser flow and need no
            changes; the mobile sign-in screen links to the same SSO page.
          </li>
        </BulletList>
      </Section>

      <Section id="prerequisites" title="Before you start">
        <BulletList>
          <li>
            <strong>An identity provider</strong> that speaks OIDC or SAML 2.0
            (Okta, Microsoft Entra ID, Google Workspace, Keycloak, and others).
          </li>
          <li>
            <strong>Control of your email domain&rsquo;s DNS.</strong> You prove
            you own the domain by adding a TXT record to it, so you need access
            to wherever its DNS is hosted.
          </li>
          <li>
            <strong>A free seat for every member who will sign in.</strong> Each
            member&rsquo;s first SSO sign-in takes one of your team&rsquo;s
            seats, the same as inviting them. If the team is full, the sign-in
            is refused until a seat is free.
          </li>
          <li>
            <strong>For OIDC, a provider reachable from the internet.</strong>{" "}
            SourceWeft&rsquo;s servers call your OIDC provider&rsquo;s discovery,
            token and key endpoints directly, and refuse private or internal
            addresses. If your identity provider is only reachable inside your
            network, use SAML instead, where the member&rsquo;s browser carries
            the assertion.
          </li>
        </BulletList>
      </Section>

      <Section id="setup" title="Set up a provider">
        <SubSection id="add-provider" title="1. Add the provider">
          <p>
            In your team&rsquo;s settings, open the{" "}
            <Code>Single sign-on</Code> tab and choose{" "}
            <Code>Add identity provider</Code>. Pick the sign-in protocol and
            fill in the fields for it. You also give the provider a{" "}
            <Code>Provider ID</Code> (3–64 lowercase letters, digits or hyphens)
            and the <Code>Email domain</Code> it serves. A team can have up to
            five providers.
          </p>
          <DataTable
            head={["Protocol", "What you enter"]}
            rows={[
              [
                "OIDC",
                <>
                  The <Code>Issuer URL</Code>, <Code>Client ID</Code> and{" "}
                  <Code>Client secret</Code> of an application you create in your
                  identity provider, plus optional <Code>Scopes</Code> (defaults
                  to <Code>openid email profile</Code>). SourceWeft discovers the
                  rest of the endpoints from the issuer.
                </>,
              ],
              [
                "SAML",
                <>
                  The <Code>IdP sign-on URL</Code>, the{" "}
                  <Code>IdP signing certificate</Code> (PEM) and the{" "}
                  <Code>IdP entity ID / issuer</Code>. You can instead paste the
                  IdP metadata XML to fill those three fields; the metadata
                  itself is not stored, and SourceWeft does not fetch it by URL.
                </>,
              ],
            ]}
          />
          <div id="saml-signing" className="scroll-mt-8" />
          <Note title="SAML signing requirements">
            <p>
              SourceWeft accepts a SAML response only when its assertion is{" "}
              <strong>signed</strong> (the assertion element itself, not only the
              response envelope) and <strong>unencrypted</strong>, using an
              accepted algorithm:
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-6">
              <li>
                Signature algorithm: <Code>RSA-SHA256</Code> or{" "}
                <Code>RSA-SHA512</Code>.
              </li>
              <li>
                Digest algorithm: <Code>SHA-256</Code> or <Code>SHA-512</Code>.
              </li>
            </ul>
            <p>
              Anything else is refused — see{" "}
              <a href="#limitations" className="underline">
                what is not supported
              </a>{" "}
              for the full list of rejected algorithms and XML constructs. A
              refused response sends the member to the sign-in error page with
              code <Code>SSO_SAML_ALGORITHM_NOT_ALLOWED</Code>.
            </p>
          </Note>
        </SubSection>

        <SubSection id="sp-values" title="2. Give your identity provider the SourceWeft details">
          <p>
            The dialog shows a <Code>Service provider details</Code> panel with
            the URLs your identity provider needs. Enter the ones that match
            your protocol. <Code>&lt;apiBaseUrl&gt;</Code> is the SourceWeft API
            origin and <Code>&lt;providerId&gt;</Code> is the provider ID you
            chose; the OIDC redirect URI is the same for every provider, while
            the SAML URLs carry the provider ID.
          </p>
          <DataTable
            head={["Value", "URL", "Give it to the IdP as"]}
            rows={[
              [
                <Code key="v">OIDC redirect URI</Code>,
                <Code key="u">&lt;apiBaseUrl&gt;/api/auth/sso/callback</Code>,
                "The application's redirect / callback / sign-in URL",
              ],
              [
                <Code key="v">SAML ACS URL</Code>,
                <Code key="u">
                  &lt;apiBaseUrl&gt;/api/auth/sso/saml2/sp/acs/&lt;providerId&gt;
                </Code>,
                "The Assertion Consumer Service (ACS), Reply or Single sign-on URL",
              ],
              [
                <Code key="v">SAML SP metadata URL</Code>,
                <Code key="u">
                  &lt;apiBaseUrl&gt;/api/auth/sso/saml2/sp/metadata?providerId=&lt;providerId&gt;
                </Code>,
                "Import it where the IdP accepts service-provider metadata",
              ],
              [
                <Code key="v">SAML SP entity ID</Code>,
                <>The same URL as the SP metadata.</>,
                "The Audience / SP Entity ID the IdP sends the assertion to",
              ],
            ]}
          />
          <Note title="OIDC redirect URI must match exactly">
            <p>
              Many identity providers reject a sign-in if the redirect URI is
              not registered character for character. Copy it from the panel
              rather than typing it.
            </p>
          </Note>
        </SubSection>

        <SubSection id="verify-domain" title="3. Verify the email domain">
          <p>
            Until the domain is verified, no one can sign in through the
            provider. The <Code>Verify domain ownership</Code> panel shows a{" "}
            <Code>TXT record name</Code> and a <Code>TXT record value</Code>.
            Add that TXT record to the DNS of your domain, then come back and
            choose <Code>Verify</Code>. The record name has the form{" "}
            <Code>_sourceweft-sso-&lt;providerId&gt;.&lt;domain&gt;</Code>; use
            the exact name and value shown in the panel.
          </p>
          <p>
            DNS changes can take a few minutes to take effect, so if the first
            attempt does not find the record, wait a little and verify again.
            You can leave the TXT record in place; removing it after
            verification does not sign anyone out, but keeping it lets a
            re-verification succeed later.
          </p>
        </SubSection>

        <SubSection id="test" title="4. Test the sign-in">
          <p>
            Sign in yourself with an address on the verified domain: open the
            sign-in page, choose <Code>Sign in with SSO</Code>, and enter your
            work email. You should be sent to your identity provider and back,
            and land signed in. If something is wrong, the error page carries a
            code — see <a href="#troubleshooting" className="underline">
              Troubleshooting
            </a>
            .
          </p>
        </SubSection>

        <SubSection id="share" title="5. Share the direct sign-in link">
          <p>
            The panel also shows a <Code>Direct sign-in link</Code> of the form{" "}
            <Code>&lt;webOrigin&gt;/auth/sso?org=&lt;slug&gt;</Code>. Share it
            with your members so they land straight on the SSO screen for your
            team.
          </p>
        </SubSection>
      </Section>

      <Section id="idps" title="Notes for specific identity providers">
        <p>
          The setup is the same for every provider; only the names of the
          fields differ. In all cases:
        </p>
        <BulletList>
          <li>
            Enter SourceWeft&rsquo;s URLs from the{" "}
            <a href="#sp-values" className="underline">
              service-provider panel
            </a>
            : for OIDC the <strong>redirect URI</strong>; for SAML the{" "}
            <strong>ACS URL</strong> and the <strong>SP entity ID</strong> (the
            metadata URL), or import the SP metadata where the provider accepts
            it.
          </li>
          <li>
            Make sure the identity provider sends the member&rsquo;s{" "}
            <strong>email</strong> and a <strong>stable identifier</strong>. For
            OIDC that is the <Code>email</Code> claim and the <Code>sub</Code>{" "}
            claim. For SAML it is an <Code>email</Code> attribute (SourceWeft
            falls back to the <Code>NameID</Code> if there is none), and the{" "}
            <Code>NameID</Code> is the stable identifier — send a persistent
            NameID, not one that changes between sign-ins.
          </li>
          <li>
            For SAML, the <strong>assertion itself must be signed</strong> (not
            only the response envelope), <strong>unencrypted</strong>, and signed
            with an accepted algorithm: the signature must be{" "}
            <Code>RSA-SHA256</Code> or <Code>RSA-SHA512</Code> and the digest{" "}
            <Code>SHA-256</Code> or <Code>SHA-512</Code>. See{" "}
            <a href="#saml-signing" className="underline">
              SAML signing requirements
            </a>
            . SourceWeft always requires signed assertions for a provider you
            register here.
          </li>
        </BulletList>
        <DataTable
          head={["Identity provider", "What to configure"]}
          rows={[
            [
              "Okta",
              <>
                Create an OIDC app integration, or a SAML app. For SAML, set the
                single sign-on / ACS URL to the ACS URL and the audience to the
                SP entity ID; have it send the member&rsquo;s email and a
                persistent NameID; sign the assertion; set the signature
                algorithm to <Code>RSA-SHA256</Code> and leave assertion
                encryption off.
              </>,
            ],
            [
              "Microsoft Entra ID",
              <>
                Register an application for OIDC, or set up SAML-based sign-on.
                For SAML, set the reply (ACS) URL to the ACS URL and the
                identifier (entity ID) to the SP entity ID; set the signing
                algorithm to <Code>RSA-SHA256</Code>; sign the assertion; and
                leave assertion encryption off.
              </>,
            ],
            [
              "Google Workspace",
              <>
                Add a custom SAML app. Set the ACS URL and the entity ID to the
                values from the panel; map the member&rsquo;s primary email to
                the <Code>email</Code> attribute; set the signing algorithm to{" "}
                <Code>RSA-SHA256</Code>; sign the assertion; and do not turn on
                assertion encryption.
              </>,
            ],
            [
              "Keycloak",
              <>
                Create an OIDC client (confidential, with a client secret) or a
                SAML client. For OIDC set the valid redirect URI to the redirect
                URI; for SAML set the valid redirect / ACS URL to the ACS URL and
                the client ID to the SP entity ID. For SAML, turn on sign
                assertions, leave encrypt assertions off, and set the signature
                algorithm to <Code>RSA-SHA256</Code>.
              </>,
            ],
          ]}
        />
        <Note title="Do not know a field name?">
          <p>
            Identity-provider consoles change their wording often. If a field is
            named differently, match it by purpose: the place your provider
            sends the member after sign-in is the redirect URI (OIDC) or ACS URL
            (SAML); the name your provider puts in the assertion&rsquo;s audience
            is the SP entity ID.
          </p>
        </Note>
      </Section>

      <Section id="roles" title="Role mapping">
        <p>
          By default every member who signs in through SSO is a plain{" "}
          <Code>member</Code>. You can let the identity provider decide who is an{" "}
          <Code>admin</Code> instead, by filling two optional fields when you add
          or edit the provider:
        </p>
        <BulletList>
          <li>
            <Code>Role attribute</Code> — the claim (OIDC) or attribute (SAML)
            that carries the member&rsquo;s role.
          </li>
          <li>
            <Code>Admin role value</Code> — members whose role attribute equals
            this value are made <Code>admin</Code>; everyone else is{" "}
            <Code>member</Code>.
          </li>
        </BulletList>
        <p>
          The value is matched whole, so a role attribute returning{" "}
          <Code>dev,sw-admins</Code> as a single string is not treated as
          containing <Code>sw-admins</Code>; send the admin value as its own
          string, or as one element of a list. A member&rsquo;s role is synced on
          every sign-in, so removing someone from the admin group in your
          identity provider demotes them to <Code>member</Code> next time they
          sign in.
        </p>
        <Note title="SSO never changes an owner">
          <p>
            Role mapping only ever sets <Code>member</Code> or <Code>admin</Code>
            . It never grants or removes <Code>owner</Code>: a team owner stays
            an owner no matter what the identity provider asserts. Promote or
            remove owners in SourceWeft yourself.
          </p>
        </Note>
      </Section>

      <Section id="first-sign-in" title="What happens on first sign-in">
        <BulletList>
          <li>
            <strong>A new member is created and joined to the team.</strong> If
            no SourceWeft account has that email yet, one is created (already
            email-verified, because ownership of the domain is proven) and added
            to your team.
          </li>
          <li>
            <strong>An existing account is linked.</strong> If someone already
            has a SourceWeft account with that email, their SSO sign-in links to
            it — but only when the email is on the provider&rsquo;s{" "}
            <em>verified</em> domain. An identity provider that returns an email
            outside the verified domain can never take over an existing account.
          </li>
          <li>
            <strong>A team seat is used.</strong> The first sign-in takes a seat,
            like an invitation. With no seats left the sign-in is rolled back —
            no account is created and no session is left behind — and the member
            is told to ask an administrator for a seat.
          </li>
          <li>
            <strong>Subdomains are trusted.</strong> A provider verified for{" "}
            <Code>acme.com</Code> also covers{" "}
            <Code>user@mail.acme.com</Code> — unless you register a separate,
            verified provider for the exact subdomain, which then takes
            precedence for that subdomain.
          </li>
        </BulletList>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <p>
          SSO errors show up in one of two places. A problem saving a provider
          is shown inline in the Add / Edit dialog (or the verification panel) as
          a message — the admin sees the message, not the code. A problem while a
          member signs in is shown either on the <Code>/auth/sso</Code> form, or
          on the sign-in error page at{" "}
          <Code>/auth/error?error=&lt;CODE&gt;</Code>, which shows both the
          message and the code. The English messages are quoted below.
        </p>

        <SubSection id="ts-setup" title="When setting up a provider">
          <p>
            Returned when an owner or admin saves a provider or verifies a
            domain, and shown inline in the dialog.
          </p>
          <DataTable
            head={["Code / message", "Cause", "What to do"]}
            rows={[
              [
                <>
                  <Code key="c">SSO_DOMAIN_NOT_ALLOWED</Code>
                  <br />
                  &ldquo;This domain cannot be used for single sign-on.&rdquo;
                </>,
                <>
                  The domain is a public mailbox provider, is not a valid host
                  name, is already used by another provider in your own team, or
                  has been verified by another team.
                </>,
                "Use a valid domain your team controls, and only once per team.",
              ],
              [
                <>
                  <Code key="c">SSO_PROVIDER_LIMIT</Code>
                  <br />
                  &ldquo;This team has reached the limit of 5 identity
                  providers.&rdquo;
                </>,
                "The team already has five providers.",
                "Remove a provider you no longer use before adding another.",
              ],
              [
                <>
                  <Code key="c">SSO_INVALID_ROLE_ATTRIBUTE</Code>
                  <br />
                  &ldquo;This role attribute name can&rsquo;t be used. Choose a
                  different attribute.&rdquo;
                </>,
                <>
                  The role attribute is a reserved field (<Code>id</Code>,{" "}
                  <Code>email</Code>, <Code>emailVerified</Code>,{" "}
                  <Code>name</Code> or <Code>image</Code>) or is too long.
                </>,
                <>
                  Choose a different{" "}
                  <a href="#roles" className="underline">
                    role attribute
                  </a>{" "}
                  name.
                </>,
              ],
              [
                <>
                  <Code key="c">SSO_ORGANIZATION_REQUIRED</Code>
                  <br />
                  &ldquo;Single sign-on can only be set up for a team.&rdquo;
                </>,
                "You are not in a team organization.",
                "Set it up from a team, not a personal organization.",
              ],
            ]}
          />
        </SubSection>

        <SubSection id="ts-signin" title="When signing in">
          <p>
            Shown to a member during sign-in: the first two on the{" "}
            <Code>/auth/sso</Code> form, the rest on the error page at{" "}
            <Code>/auth/error?error=&lt;CODE&gt;</Code>.
          </p>
          <DataTable
            head={["Code / message", "Cause", "What to do"]}
            rows={[
              [
                <>
                  <Code key="c">SSO_PROVIDER_NOT_FOUND</Code>
                  <br />
                  &ldquo;No single sign-on is set up for this email
                  address.&rdquo;
                </>,
                "The email&rsquo;s domain has no verified provider.",
                "Check the address is on a domain you registered and verified.",
              ],
              [
                <>
                  <Code key="c">SSO_DOMAIN_NOT_VERIFIED</Code>
                  <br />
                  &ldquo;This domain has not been verified yet. Ask your
                  administrator to finish setup.&rdquo;
                </>,
                "The provider exists but its domain is not verified.",
                <>
                  Finish{" "}
                  <a href="#verify-domain" className="underline">
                    domain verification
                  </a>
                  .
                </>,
              ],
              [
                <>
                  <Code key="c">SSO_ACCOUNT_LINK_DENIED</Code>
                  <br />
                  &ldquo;This sign-in cannot be linked to an existing account.
                  Contact your administrator.&rdquo;
                </>,
                "The identity provider returned an email outside the verified domain (or no email).",
                "Make the IdP send the member&rsquo;s work email on the verified domain.",
              ],
              [
                <>
                  <Code key="c">SSO_SEAT_LIMIT</Code>
                  <br />
                  &ldquo;Your team has no seats left. Ask your administrator to
                  add seats.&rdquo;
                </>,
                "The team has no free seat for the new member.",
                "Add seats to the team, then try again.",
              ],
              [
                <>
                  <Code key="c">SSO_PROVISIONING_FAILED</Code>
                  <br />
                  &ldquo;We couldn&rsquo;t add you to your team. Try again, or
                  contact your administrator.&rdquo;
                </>,
                "Adding the member failed for a reason other than seats.",
                "Try again; if it persists, contact support.",
              ],
              [
                <>
                  <Code key="c">SSO_ORGANIZATION_REQUIRED</Code>
                  <br />
                  &ldquo;Single sign-on can only be set up for a team.&rdquo;
                </>,
                "The provider&rsquo;s team is no longer a team organization.",
                "Restore the team, or remove the provider.",
              ],
              [
                <>
                  <Code key="c">SSO_SAML_ALGORITHM_NOT_ALLOWED</Code>
                  <br />
                  &ldquo;Your identity provider&rsquo;s SAML response uses
                  signature settings that aren&rsquo;t supported&hellip;&rdquo;
                </>,
                <>
                  The SAML response&rsquo;s signature or digest algorithm is
                  outside the accepted set, or it contains an unsupported
                  construct (an XML comment, CDATA section, processing
                  instruction or DOCTYPE, an encrypted assertion, or XML that is
                  not well-formed).
                </>,
                "Set the IdP&rsquo;s SAML signature algorithm to RSA-SHA256 and the digest to SHA-256, and turn off assertion encryption.",
              ],
            ]}
          />
        </SubSection>
      </Section>

      <Section id="security" title="Security">
        <BulletList>
          <li>
            <strong>Secrets are encrypted and never shown again.</strong> An
            OIDC client secret is encrypted for your team before it is stored and
            is never returned to the browser. When you edit a provider, leave the
            secret (or a SAML certificate) blank to keep the stored value.
          </li>
          <li>
            <strong>Every change is in the team audit log.</strong> Registering,
            updating and deleting a provider, verifying a domain, and each SSO
            sign-in are recorded (<Code>sso.provider_created</Code>,{" "}
            <Code>sso.provider_updated</Code>, <Code>sso.provider_deleted</Code>,{" "}
            <Code>sso.domain_verified</Code>, <Code>sso.sign_in</Code>), along
            with the membership entries a sign-in produces (
            <Code>organization.member_added</Code> and{" "}
            <Code>organization.member_role_changed</Code>). The log records the
            provider, protocol and domain — never a secret, certificate or claim
            value.
          </li>
          <li>
            <strong>Domain ownership is the trust boundary.</strong> An account
            is only ever linked or created when the email is on a domain your
            team has verified and that matches the provider, so one team cannot
            claim another team&rsquo;s — or a public mailbox provider&rsquo;s —
            domain.
          </li>
        </BulletList>
      </Section>

      <Section id="limitations" title="What is not supported yet">
        <p>These are not available in this release:</p>
        <BulletList>
          <li>Requiring SSO for a domain (you cannot yet force it on).</li>
          <li>Automatic user provisioning or de-provisioning (SCIM).</li>
          <li>SAML Single Logout (SLO).</li>
          <li>IdP-initiated SAML sign-in (start the sign-in from SourceWeft).</li>
          <li>LDAP or Active Directory direct bind.</li>
          <li>
            SAML responses signed with anything other than{" "}
            <Code>RSA-SHA256</Code> or <Code>RSA-SHA512</Code> (with an{" "}
            <Code>SHA-256</Code> or <Code>SHA-512</Code> digest). SHA-1,{" "}
            <Code>RSA-SHA384</Code> and <Code>SHA-384</Code> digests, ECDSA, HMAC
            and RSA-PSS signatures are all refused.
          </li>
          <li>
            Encrypted SAML assertions, and SAML responses that contain an XML
            comment, a CDATA section, a processing instruction or a DOCTYPE, or
            that are not well-formed XML.
          </li>
          <li>
            OIDC identity providers that are not reachable from SourceWeft&rsquo;s
            servers (private or internal addresses are refused). Use SAML for an
            internal identity provider.
          </li>
        </BulletList>
      </Section>
    </main>
  );
}
