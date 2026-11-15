"use client"

import type { AuthButtonProps } from "@better-auth-ui/react"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { Building2 } from "lucide-react"

import { buttonVariants } from "@sourceweft/ui-web/components/ui/button"
import { ssoPlugin } from "@/lib/auth/sso-plugin"
import { cn } from "@sourceweft/ui-web/lib/utils"

import { useIsHydrated } from "../use-is-hydrated"
import { withRedirectTo } from "./sso-redirect"

export type SsoButtonProps = AuthButtonProps

/**
 * Link from a sign-in surface to the `/auth/sso` work-email view, carrying the
 * current `redirectTo` query parameter so the post-sign-in destination survives
 * the hop (and the trip back). Contributed to `authButtons`, so it renders on
 * both the password sign-in form and the magic-link fallback.
 */
export function SsoButton({ className }: SsoButtonProps) {
  const { basePaths, Link } = useAuth()
  const { localization, viewPaths } = useAuthPlugin(ssoPlugin)
  const isHydrated = useIsHydrated()

  const href = withRedirectTo(
    `${basePaths.auth}/${viewPaths.auth.sso}`,
    isHydrated
  )

  return (
    <Link
      href={href}
      className={cn(buttonVariants({ variant: "outline" }), "w-full", className)}
    >
      <Building2 />
      {localization.signInWithSso}
    </Link>
  )
}
