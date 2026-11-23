import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  emailOtpPlugin as coreEmailOtpPlugin,
  type EmailOtpPluginOptions
} from "@better-auth-ui/core/plugins/email-otp"

import { EmailOtpButton } from "@/app/_components/auth/email-otp/email-otp-button"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const ChangeEmailOtp = dynamic(() =>
  import("@/app/_components/auth/email-otp/change-email-otp").then(
    (module) => module.ChangeEmailOtp
  )
)
const EmailOtp = dynamic(() =>
  import("@/app/_components/auth/email-otp/email-otp").then(
    (module) => module.EmailOtp
  )
)
const ForgotPasswordOtp = dynamic(() =>
  import("@/app/_components/auth/email-otp/forgot-password-otp").then(
    (module) => module.ForgotPasswordOtp
  )
)
const ResetPasswordOtp = dynamic(() =>
  import("@/app/_components/auth/email-otp/reset-password-otp").then(
    (module) => module.ResetPasswordOtp
  )
)
const VerifyEmailOtp = dynamic(() =>
  import("@/app/_components/auth/email-otp/verify-email-otp").then(
    (module) => module.VerifyEmailOtp
  )
)

export const emailOtpPlugin = createAuthPlugin(
  coreEmailOtpPlugin.id,
  (options: EmailOtpPluginOptions = {}) => {
    const plugin = coreEmailOtpPlugin(options)

    return {
      ...plugin,
      authButtons: plugin.signIn ? [EmailOtpButton] : [],
      // Each flow is opt-in because it replaces a link-based view outright.
      // Turning one on without the matching server option would leave the
      // user waiting for a code that never arrives.
      views: {
        auth: {
          ...(plugin.signIn && { emailOtp: EmailOtp }),
          ...(plugin.emailVerification && { verifyEmail: VerifyEmailOtp }),
          ...(plugin.passwordReset && {
            forgotPassword: ForgotPasswordOtp,
            resetPassword: ResetPasswordOtp
          })
        }
      },
      // Conditional, not an override: when `emailAndPassword.enabled === false`
      // the `<Auth>` router renders this at `/auth/sign-in` instead of the
      // disabled password form.
      ...(plugin.signIn && {
        fallbackViews: { auth: { signIn: EmailOtp } }
      }),
      ...(plugin.changeEmail && {
        cardOverrides: { account: { changeEmail: ChangeEmailOtp } }
      })
    }
  }
)
