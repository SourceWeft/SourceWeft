import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"

import { SsoButton } from "@/app/_components/auth/sso/sso-button"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const SsoSignIn = dynamic(() =>
  import("@/app/_components/auth/sso/sso-sign-in").then(
    (module) => module.SsoSignIn
  )
)
const OrganizationSso = dynamic(() =>
  import("@/app/_components/auth/organization/sso/organization-sso").then(
    (module) => module.OrganizationSso
  )
)
const SsoOrganizationTabLabel = dynamic(() =>
  import("@/app/_components/auth/organization/sso/organization-sso").then(
    (module) => module.SsoOrganizationTabLabel
  )
)

/**
 * Localization contributed by the SSO UI plugin. Read at runtime via
 * `useAuthPlugin(ssoPlugin).localization`, which merges these defaults with the
 * `authLocale.plugins.sso` overrides from `messages/<locale>.json` (see
 * `lib/i18n/auth-locale.ts`). The defaults below are the English source and
 * must stay in step with `messages/en.json` — `lib/i18n/auth-locale.test.ts`
 * fails if a key is missing from any locale.
 *
 * `signInWith*`/`sso*`/`workEmail`/`continue`/`backToSignIn` belong to the
 * sign-in entry. Everything prefixed `org` belongs to the organization
 * settings "Single sign-on" tab.
 */
export type SsoLocalization = {
  signInWithSso: string
  ssoTitle: string
  ssoDescription: string
  workEmail: string
  continue: string
  backToSignIn: string
  ssoEmailRequired: string
  ssoRateLimited: string
  ssoNoSetup: string

  orgTabLabel: string
  orgTitle: string
  orgDescription: string
  orgTeamsOnly: string
  orgNoPermission: string
  orgAddProvider: string
  orgProviderLimitReached: string
  orgEmptyTitle: string
  orgEmptyDescription: string

  orgColumnProvider: string
  orgColumnDomain: string
  orgColumnType: string
  orgColumnStatus: string
  orgColumnActions: string
  orgStatusVerified: string
  orgStatusPending: string
  orgProtocolOidc: string
  orgProtocolSaml: string
  orgDetails: string
  orgEdit: string
  orgDelete: string

  orgCreateTitle: string
  orgEditTitle: string
  orgCreateDescription: string
  orgEditDescription: string
  orgProtocol: string
  orgProviderId: string
  orgProviderIdHint: string
  orgProviderIdImmutableHint: string
  orgDomain: string
  orgDomainChangeWarning: string
  orgIssuer: string
  orgIssuerHint: string
  orgClientId: string
  orgClientIdKeepHint: string
  orgClientSecret: string
  orgClientSecretKeepHint: string
  orgScopes: string
  orgScopesHint: string
  orgSamlConfigHint: string
  orgEntryPoint: string
  orgIdpEntityId: string
  orgCertificate: string
  orgCertificateHint: string
  orgSamlMetadata: string
  orgSamlMetadataHint: string
  orgSamlKeepHint: string
  orgRoleAttribute: string
  orgRoleAttributeHint: string
  orgAdminRoleValue: string
  orgAdminRoleValueHint: string
  orgSamlSecurityNote: string
  orgSave: string
  orgCancel: string
  orgCreateSuccess: string
  orgUpdateSuccess: string
  orgFieldRequired: string
  orgProviderIdInvalid: string
  orgEntryPointInvalid: string
  orgCertificateInvalid: string
  orgMetadataTooLarge: string
  orgMetadataParseError: string
  orgMetadataNoEntryPoint: string
  orgMetadataNoEntityId: string
  orgMetadataNoCert: string
  orgMetadataMultipleCerts: string
  orgSamlNeedsConfig: string
  orgRateLimited: string
  orgProviderIdTaken: string
  orgProviderIdReserved: string
  orgIssuerInvalid: string
  orgIssuerUnreachable: string
  orgIdentityLocked: string
  orgIdentityLockedHint: string
  orgRoleMappingIncomplete: string
  orgErrDomainVerificationFailed: string
  orgErrNoPendingVerification: string
  orgErrInvalidDomain: string
  orgErrIdentifierTooLong: string
  orgErrProviderChanged: string
  orgServiceProviderPending: string
  orgDirectSignInDescription: string
  orgDirectSignInNone: string
  orgDirectSignInMany: string

  orgDomainVerification: string
  orgDomainVerificationDescription: string
  orgTxtRecordHost: string
  orgTxtRecordValue: string
  orgDnsPropagationNote: string
  orgVerify: string
  orgVerifying: string
  orgVerifySuccess: string
  orgCopy: string
  orgCopied: string

  orgServiceProviderInfo: string
  orgServiceProviderDescription: string
  orgOidcRedirectUri: string
  orgSamlAcsUrl: string
  orgSamlMetadataUrl: string
  orgSamlEntityId: string
  orgDirectSignInLink: string

  orgDeleteTitle: string
  orgDeleteDescription: string
  orgDeleteConfirm: string
  orgDeleteSuccess: string
}

const ssoLocalization: SsoLocalization = {
  signInWithSso: "Sign in with SSO",
  ssoTitle: "Single sign-on",
  ssoDescription:
    "Enter your work email to continue with your company's sign-in.",
  workEmail: "Work email",
  continue: "Continue",
  backToSignIn: "Back to sign in",
  ssoEmailRequired: "Enter your work email address.",
  ssoRateLimited: "Too many attempts. Please wait a minute and try again.",
  ssoNoSetup: "No single sign-on is set up for this email address.",

  orgTabLabel: "Single sign-on",
  orgTitle: "Single sign-on",
  orgDescription:
    "Let members of a verified email domain sign in through your identity provider.",
  orgTeamsOnly: "Single sign-on is available for teams.",
  orgNoPermission:
    "Only team owners and admins can manage single sign-on.",
  orgAddProvider: "Add identity provider",
  orgProviderLimitReached: "You can add up to 5 identity providers per team.",
  orgEmptyTitle: "No identity providers yet",
  orgEmptyDescription:
    "Connect an identity provider (OIDC or SAML) and verify the email domain you control to let members sign in with SSO.",

  orgColumnProvider: "Provider",
  orgColumnDomain: "Domain",
  orgColumnType: "Type",
  orgColumnStatus: "Status",
  orgColumnActions: "Actions",
  orgStatusVerified: "Verified",
  orgStatusPending: "Pending verification",
  orgProtocolOidc: "OIDC",
  orgProtocolSaml: "SAML",
  orgDetails: "Details",
  orgEdit: "Edit",
  orgDelete: "Delete",

  orgCreateTitle: "Add identity provider",
  orgEditTitle: "Edit identity provider",
  orgCreateDescription:
    "Register an OIDC or SAML identity provider for a domain your team controls.",
  orgEditDescription:
    "Update this identity provider. Leave secrets blank to keep the current values.",
  orgProtocol: "Sign-in protocol",
  orgProviderId: "Provider ID",
  orgProviderIdHint:
    "Lowercase letters, digits and hyphens, 3–47 characters.",
  orgProviderIdImmutableHint:
    "The provider ID cannot be changed after creation.",
  orgDomain: "Email domain",
  orgDomainChangeWarning:
    "Changing the domain requires verifying it again and blocks sign-in until it is verified.",
  orgIssuer: "Issuer URL",
  orgIssuerHint:
    "We discover the OIDC endpoints from the issuer. Internal/private issuers are rejected.",
  orgClientId: "Client ID",
  orgClientIdKeepHint: "Leave blank to keep the current client ID.",
  orgClientSecret: "Client secret",
  orgClientSecretKeepHint: "Leave blank to keep the current secret.",
  orgScopes: "Scopes",
  orgScopesHint: "Space-separated. Defaults to openid email profile.",
  orgSamlConfigHint:
    "Enter the IdP sign-on URL, signing certificate and entity ID below, or paste the IdP metadata XML to fill them.",
  orgEntryPoint: "IdP sign-on URL",
  orgIdpEntityId: "IdP entity ID / issuer",
  orgCertificate: "IdP signing certificate",
  orgCertificateHint:
    "Paste the PEM certificate, or fill it from the metadata below.",
  orgSamlMetadata: "Auto-fill from IdP metadata XML",
  orgSamlMetadataHint:
    "Paste the IdP metadata XML to fill the fields above. The metadata itself is not stored.",
  orgSamlKeepHint: "Leave blank to keep the current value.",
  orgRoleAttribute: "Role attribute (optional)",
  orgRoleAttributeHint:
    "The claim (OIDC) or attribute (SAML) that carries the member's role.",
  orgAdminRoleValue: "Admin role value (optional)",
  orgAdminRoleValueHint:
    "Members whose role attribute equals this value become admins; anyone who doesn't match is set to member at each sign-in. Owners are never changed.",
  orgSamlSecurityNote:
    "Your identity provider must sign the SAML assertion with RSA-SHA256 or RSA-SHA512 using a SHA-256 or SHA-512 digest, and send it unencrypted.",
  orgSave: "Save",
  orgCancel: "Cancel",
  orgCreateSuccess: "Identity provider added.",
  orgUpdateSuccess: "Identity provider updated.",
  orgFieldRequired: "This field is required.",
  orgProviderIdInvalid:
    "Use 3–47 lowercase letters, digits or hyphens.",
  orgEntryPointInvalid: "Enter a valid sign-on URL.",
  orgCertificateInvalid: "Enter a PEM certificate or a base64 value.",
  orgMetadataTooLarge: "The metadata XML is too large (max 100 KB).",
  orgMetadataParseError:
    "Could not read the metadata XML. Check it and paste again, or fill the fields manually.",
  orgMetadataNoEntryPoint:
    "Could not read the sign-on URL from the metadata — enter it manually.",
  orgMetadataNoEntityId:
    "Could not read the entity ID from the metadata — enter it manually.",
  orgMetadataNoCert:
    "Could not read the IdP signing certificate from the metadata — paste it manually.",
  orgMetadataMultipleCerts:
    "This IdP publishes more than one signing certificate; the first is used — confirm it is the active one.",
  orgSamlNeedsConfig:
    "Provide the sign-on URL, signing certificate and entity ID, or paste metadata XML.",
  orgRateLimited: "Too many attempts. Please wait a minute and try again.",
  orgProviderIdTaken:
    "A provider with this ID already exists. Choose a different one.",
  orgProviderIdReserved: "This provider ID is reserved. Choose a different one.",
  orgIssuerInvalid:
    "Enter a valid issuer URL starting with http:// or https://.",
  orgIssuerUnreachable:
    "SourceWeft couldn't reach this issuer. An OIDC identity provider must be reachable from the SourceWeft server over the public internet and expose a valid discovery document. For an internal identity provider, use SAML instead.",
  orgIdentityLocked:
    "These settings can't be changed after members have signed in with this provider. To change them, delete the provider and add it again.",
  orgIdentityLockedHint:
    "The issuer, client ID, and the SAML sign-on URL, certificate and entity ID can't be changed after members have signed in. To change them, delete the provider and add it again.",
  orgRoleMappingIncomplete:
    "Fill in both the role attribute and the admin role value, or leave both empty.",
  orgErrDomainVerificationFailed:
    "We couldn't find the TXT record yet. DNS changes can take a few minutes — wait a little and verify again.",
  orgErrNoPendingVerification:
    "This verification request has expired. Request a new TXT record and verify again.",
  orgErrInvalidDomain:
    "This domain can't be verified. Check the email domain set on the provider.",
  orgErrIdentifierTooLong:
    "The provider ID is too long to create a DNS record for it.",
  orgErrProviderChanged:
    "This provider changed while the request was in progress. Reload the page and try again.",
  orgServiceProviderPending:
    "The service-provider details appear once you set a provider ID.",
  orgDirectSignInDescription:
    "Share this link to send members straight to single sign-on for this team.",
  orgDirectSignInNone:
    "Once a provider's domain is verified, members can sign in with single sign-on.",
  orgDirectSignInMany:
    "With more than one verified provider, members choose \"Sign in with SSO\" and enter their work email.",

  orgDomainVerification: "Verify domain ownership",
  orgDomainVerificationDescription:
    "Add this TXT record to the DNS for {domain} to prove you control it:",
  orgTxtRecordHost: "TXT record name",
  orgTxtRecordValue: "TXT record value",
  orgDnsPropagationNote: "DNS changes can take a few minutes to take effect.",
  orgVerify: "Verify",
  orgVerifying: "Verifying…",
  orgVerifySuccess: "Domain verified.",
  orgCopy: "Copy",
  orgCopied: "Copied",

  orgServiceProviderInfo: "Service provider details",
  orgServiceProviderDescription:
    "Give these to your identity provider administrator.",
  orgOidcRedirectUri: "OIDC redirect URI",
  orgSamlAcsUrl: "SAML ACS URL",
  orgSamlMetadataUrl: "SAML SP metadata URL",
  orgSamlEntityId: "SAML SP entity ID",
  orgDirectSignInLink: "Direct sign-in link",

  orgDeleteTitle: "Delete identity provider",
  orgDeleteDescription:
    "Members who sign in on this domain will no longer be able to use SSO. This cannot be undone.",
  orgDeleteConfirm: "Delete provider",
  orgDeleteSuccess: "Identity provider deleted."
}

/**
 * UI plugin that adds the enterprise SSO sign-in entry to the web auth UI:
 * a "Sign in with SSO" button on the sign-in surfaces (`authButtons`), the
 * `/auth/sso` work-email view (`views.auth.sso`), and the organization settings
 * "Single sign-on" tab (`organizationTabs`). The `signIn.sso` call and the
 * provider-management endpoints come from `ssoClient()` in `lib/auth-client.ts`.
 *
 * Registered in `app/providers.tsx` (`<AuthProvider plugins>`) and listed in
 * `lib/auth-ui-config.ts` so `sso` lands in `authStaticPaths` and
 * `organizationStaticPaths` — without that the statically generated
 * `/auth/sso` and `/organization/sso` routes 404 (`dynamicParams = false`).
 */
export const ssoPlugin = createAuthPlugin("sso", () => ({
  localization: ssoLocalization,
  viewPaths: { auth: { sso: "sso" } },
  views: { auth: { sso: SsoSignIn } },
  authButtons: [SsoButton],
  organizationTabs: [
    {
      id: "sso",
      path: "sso",
      label: <SsoOrganizationTabLabel />,
      component: OrganizationSso
    }
  ]
}))
