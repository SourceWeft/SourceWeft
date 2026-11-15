import { createAuthPlugin } from "@better-auth-ui/core"

import { SsoButton } from "@/app/_components/auth/sso/sso-button"
import { SsoSignIn } from "@/app/_components/auth/sso/sso-sign-in"

/**
 * Localization contributed by the SSO UI plugin. Read at runtime via
 * `useAuthPlugin(ssoPlugin).localization`, which merges these defaults with the
 * `authLocale.plugins.sso` overrides from `messages/<locale>.json` (see
 * `lib/i18n/auth-locale.ts`). The defaults below are the English source and
 * must stay in step with `messages/en.json`.
 */
export type SsoLocalization = {
  /** Label of the button that sends the user to the SSO sign-in view. */
  signInWithSso: string
  /** Title of the `/auth/sso` view. */
  ssoTitle: string
  /** Supporting copy under the title. */
  ssoDescription: string
  /** Work-email field label. */
  workEmail: string
  /** Submit button label. */
  continue: string
  /** Link back to the normal sign-in page. */
  backToSignIn: string
}

const ssoLocalization: SsoLocalization = {
  signInWithSso: "Sign in with SSO",
  ssoTitle: "Single sign-on",
  ssoDescription:
    "Enter your work email to continue with your company's sign-in.",
  workEmail: "Work email",
  continue: "Continue",
  backToSignIn: "Back to sign in"
}

/**
 * UI plugin that adds the enterprise SSO sign-in entry to the web auth UI:
 * a "Sign in with SSO" button on the sign-in surfaces (`authButtons`) and the
 * `/auth/sso` work-email view (`views.auth.sso`). The `signIn.sso` call itself
 * is made against `authClient`, which gains the endpoint from `ssoClient()` in
 * `lib/auth-client.ts`.
 *
 * Registered in `app/providers.tsx` (`<AuthProvider plugins>`) and listed in
 * `lib/auth-ui-config.ts` so `sso` lands in `authStaticPaths` — without that the
 * statically generated `/auth/sso` route 404s (`dynamicParams = false`).
 */
export const ssoPlugin = createAuthPlugin("sso", () => ({
  localization: ssoLocalization,
  viewPaths: { auth: { sso: "sso" } },
  views: { auth: { sso: SsoSignIn } },
  authButtons: [SsoButton]
}))
