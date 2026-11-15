import { createAuthPlugin } from "@better-auth-ui/core"

import { SsoButton } from "@/app/_components/auth/sso/sso-button"
import { SsoSignIn } from "@/app/_components/auth/sso/sso-sign-in"
import {
  OrganizationSso,
  SsoOrganizationTabLabel
} from "@/app/_components/auth/organization/sso/organization-sso"

/**
 * Localization contributed by the SSO UI plugin. Read at runtime via
 * `useAuthPlugin(ssoPlugin).localization`, which merges these defaults with the
 * `authLocale.plugins.sso` overrides from `messages/<locale>.json` (see
 * `lib/i18n/auth-locale.ts`). The defaults below are the English source and
 * must stay in step with `messages/en.json` — `lib/i18n/auth-locale.test.ts`
 * fails if a key is missing from any locale.
 *
 * `signInWith*`/`sso*`/`workEmail`/`continue`/`backToSignIn` belong to the
 * sign-in entry (Task 8). Everything prefixed `org` belongs to the organization
 * settings "Single sign-on" tab.
 */
export type SsoLocalization = {
  signInWithSso: string
  ssoTitle: string
  ssoDescription: string
  workEmail: string
  continue: string
  backToSignIn: string

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
  orgRoleAttribute: string
  orgRoleAttributeHint: string
  orgAdminRoleValue: string
  orgAdminRoleValueHint: string
  orgSave: string
  orgCancel: string
  orgCreateSuccess: string
  orgUpdateSuccess: string
  orgFieldRequired: string
  orgProviderIdInvalid: string
  orgCertificateInvalid: string
  orgMetadataTooLarge: string
  orgSamlNeedsConfig: string

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
  orgProtocol: "Protocol",
  orgProviderId: "Provider ID",
  orgProviderIdHint:
    "Lowercase letters, digits and hyphens, 3–64 characters.",
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
    "Provide the IdP sign-on URL, certificate and entity ID, or paste the IdP metadata XML below.",
  orgEntryPoint: "IdP sign-on URL",
  orgIdpEntityId: "IdP entity ID / issuer",
  orgCertificate: "IdP signing certificate",
  orgCertificateHint: "Paste the PEM certificate.",
  orgSamlMetadata: "IdP metadata XML",
  orgSamlMetadataHint:
    "Paste the IdP metadata XML to fill the fields above automatically.",
  orgRoleAttribute: "Role attribute (optional)",
  orgRoleAttributeHint:
    "Claim or attribute that carries the member's role. Members are only ever made admin or member, never owner.",
  orgAdminRoleValue: "Admin role value (optional)",
  orgAdminRoleValueHint:
    "Members whose role attribute equals this value are given the admin role.",
  orgSave: "Save",
  orgCancel: "Cancel",
  orgCreateSuccess: "Identity provider added.",
  orgUpdateSuccess: "Identity provider updated.",
  orgFieldRequired: "This field is required.",
  orgProviderIdInvalid:
    "Use 3–64 lowercase letters, digits or hyphens.",
  orgCertificateInvalid: "Enter a PEM certificate or a base64 value.",
  orgMetadataTooLarge: "The metadata XML is too large (max 100 KB).",
  orgSamlNeedsConfig:
    "Provide a sign-on URL, certificate and entity ID, or paste metadata XML.",

  orgDomainVerification: "Verify domain ownership",
  orgDomainVerificationDescription:
    "Add this TXT record to the DNS of",
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
