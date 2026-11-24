import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  twoFactorPlugin as coreTwoFactorPlugin,
  type TwoFactorPluginOptions
} from "@better-auth-ui/core/plugins/two-factor"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const TwoFactorChallenge = dynamic(() =>
  import("@/app/_components/auth/two-factor/two-factor-challenge").then(
    (module) => module.TwoFactorChallenge
  )
)
const TwoFactorSettings = dynamic(() =>
  import("@/app/_components/auth/two-factor/two-factor-settings").then(
    (module) => module.TwoFactorSettings
  )
)

export const twoFactorPlugin = createAuthPlugin(
  coreTwoFactorPlugin.id,
  (options: TwoFactorPluginOptions = {}) => ({
    ...coreTwoFactorPlugin(options),
    securityCards: [TwoFactorSettings],
    views: {
      auth: { twoFactor: TwoFactorChallenge }
    }
  })
)
