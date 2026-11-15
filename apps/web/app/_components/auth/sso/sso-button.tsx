"use client"

import { getAuthLinkURL } from "@better-auth-ui/core"
import type { AuthButtonProps } from "@better-auth-ui/react"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { Building2 } from "lucide-react"

import { buttonVariants } from "@sourceweft/ui-web/components/ui/button"
import { ssoPlugin } from "@/lib/auth/sso-plugin"
import { cn } from "@sourceweft/ui-web/lib/utils"

export type SsoButtonProps = AuthButtonProps

/**
 * Link from a sign-in surface to the `/auth/sso` work-email view, carrying the
 * post-sign-in destination so it survives the hop (and the trip back) — built
 * with the library's `getAuthLinkURL` from `useAuth().redirectTo`, exactly like
 * the sign-up and reset-password links. Contributed to `authButtons`, so it
 * renders on both the password sign-in form and the magic-link fallback.
 */
export function SsoButton({ className }: SsoButtonProps) {
  const { basePaths, redirectTo, Link } = useAuth()
  const { localization, viewPaths } = useAuthPlugin(ssoPlugin)

  const href = `${basePaths.auth}/${viewPaths.auth.sso}`

  return (
    <Link
      href={redirectTo ? getAuthLinkURL(href, redirectTo) : href}
      className={cn(buttonVariants({ variant: "outline" }), "w-full", className)}
    >
      <Building2 />
      {localization.signInWithSso}
    </Link>
  )
}
