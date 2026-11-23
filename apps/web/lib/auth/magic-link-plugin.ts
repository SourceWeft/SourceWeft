import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  magicLinkPlugin as coreMagicLinkPlugin,
  type MagicLinkPluginOptions
} from "@better-auth-ui/core/plugins/magic-link"

import { MagicLinkButton } from "@/app/_components/auth/magic-link-button"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const MagicLink = dynamic(() =>
  import("@/app/_components/auth/magic-link").then(
    (module) => module.MagicLink
  )
)
const MagicLinkSent = dynamic(() =>
  import("@/app/_components/auth/magic-link-sent").then(
    (module) => module.MagicLinkSent
  )
)

export const magicLinkPlugin = createAuthPlugin(
  coreMagicLinkPlugin.id,
  (options: MagicLinkPluginOptions = {}) => ({
    ...coreMagicLinkPlugin(options),
    authButtons: [MagicLinkButton],
    views: {
      auth: { magicLink: MagicLink, magicLinkSent: MagicLinkSent }
    },
    // Conditional, not an override: when `emailAndPassword.enabled === false`
    // the `<Auth>` router renders this at `/auth/sign-in` instead of the
    // disabled password form. With password auth on, the built-in `SignIn`
    // still wins.
    fallbackViews: {
      auth: { signIn: MagicLink }
    }
  })
)
