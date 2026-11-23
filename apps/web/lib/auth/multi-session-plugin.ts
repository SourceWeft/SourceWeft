import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  multiSessionPlugin as coreMultiSessionPlugin,
  type MultiSessionPluginOptions
} from "@better-auth-ui/core/plugins/multi-session"

import { SwitchAccountSubmenu } from "@/app/_components/auth/multi-session/switch-account-submenu"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const ManageAccounts = dynamic(() =>
  import("@/app/_components/auth/multi-session/manage-accounts").then(
    (module) => module.ManageAccounts
  )
)

export const multiSessionPlugin = createAuthPlugin(
  coreMultiSessionPlugin.id,
  (options: MultiSessionPluginOptions = {}) => ({
    ...coreMultiSessionPlugin(options),
    accountCards: [ManageAccounts],
    userMenuItems: [SwitchAccountSubmenu]
  })
)
