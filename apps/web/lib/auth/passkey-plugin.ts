import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  passkeyPlugin as corePasskeyPlugin,
  type PasskeyPluginOptions
} from "@better-auth-ui/core/plugins/passkey"

import { PasskeyButton } from "@/app/_components/auth/passkey/passkey-button"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const Passkeys = dynamic(() =>
  import("@/app/_components/auth/passkey/passkeys").then(
    (module) => module.Passkeys
  )
)

export const passkeyPlugin = createAuthPlugin(
  corePasskeyPlugin.id,
  (options: PasskeyPluginOptions = {}) => ({
    ...corePasskeyPlugin(options),
    authButtons: [PasskeyButton],
    securityCards: [Passkeys]
  })
)
