import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  type ApiKeyPluginOptions,
  apiKeyPlugin as coreApiKeyPlugin
} from "@better-auth-ui/core/plugins/api-key"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const ApiKeys = dynamic(() =>
  import("@/app/_components/auth/api-key/api-keys").then(
    (module) => module.ApiKeys
  )
)
const OrganizationApiKeys = dynamic(() =>
  import("@/app/_components/auth/api-key/organization-api-keys").then(
    (module) => module.OrganizationApiKeys
  )
)

export const apiKeyPlugin = createAuthPlugin(
  coreApiKeyPlugin.id,
  (options: ApiKeyPluginOptions = {}) => {
    const core = coreApiKeyPlugin(options)

    return {
      ...core,
      securityCards: [ApiKeys],
      ...(core.organization ? { organizationCards: [OrganizationApiKeys] } : {})
    }
  }
)
