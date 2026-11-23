import { createAuthPlugin } from "@better-auth-ui/core"
import dynamic from "next/dynamic"
import {
  organizationPlugin as coreOrganizationPlugin,
  type OrganizationLocalization,
  type OrganizationPluginOptions
} from "@better-auth-ui/core/plugins/organization"
import { Briefcase } from "lucide-react"

// Loaded when first shown: every page registers this plugin, but these views,
// cards and tabs appear only once someone opens them.
const AcceptInvitation = dynamic(() =>
  import("@/app/_components/auth/organization/accept-invitation").then(
    (module) => module.AcceptInvitation
  )
)
const OrganizationsSettings = dynamic(() =>
  import("@/app/_components/auth/organization/organizations-settings").then(
    (module) => module.OrganizationsSettings
  )
)

export const organizationPlugin = createAuthPlugin(
  coreOrganizationPlugin.id,
  (options: OrganizationPluginOptions = {}) => {
    const core = coreOrganizationPlugin(options)

    return {
      ...core,
      localization: core.localization as OrganizationLocalization,
      views: {
        auth: { acceptInvitation: AcceptInvitation }
      },
      settingsTabs: [
        {
          view: "organizations",
          label: (
            <>
              <Briefcase className="text-muted-foreground" />
              {core.localization.organizations}
            </>
          ),
          component: OrganizationsSettings
        }
      ]
    }
  }
)
