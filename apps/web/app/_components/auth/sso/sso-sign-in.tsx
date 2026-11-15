"use client"

import type { SsoAuthClient } from "@better-auth-ui/core/plugins/sso"
import { useAuth, useAuthPlugin } from "@better-auth-ui/react"
import { AlertCircle } from "lucide-react"
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"

import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert"
import { Button } from "@sourceweft/ui-web/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@sourceweft/ui-web/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel
} from "@sourceweft/ui-web/components/ui/field"
import { Input } from "@sourceweft/ui-web/components/ui/input"
import { Spinner } from "@sourceweft/ui-web/components/ui/spinner"
import { ssoPlugin } from "@/lib/auth/sso-plugin"
import { cn } from "@sourceweft/ui-web/lib/utils"

import { useIsHydrated } from "../use-is-hydrated"
import { withRedirectTo } from "./sso-redirect"

export type SsoSignInProps = {
  className?: string
}

/** Either branch of SSO discovery; `callbackURL`/`errorCallbackURL` are added by the caller. */
type SsoDiscovery = { email: string } | { organizationSlug: string }

/** The subset of the `signIn.sso` response this view reads. */
type SsoResponse = { error?: { message?: string | null } | null } | null | undefined

/**
 * Work-email SSO sign-in view rendered at `/auth/sso`.
 *
 * Normally the user types their work email and the backend resolves a verified
 * provider; the better-auth client then redirects the browser to the identity
 * provider. When the URL carries `?org=<slug>` the view skips the form and
 * starts the organization's provider directly, falling back to the email form
 * if that fails. Every failure shows the backend's already-localized message
 * (the auth client sends `x-sw-locale`, so `error.message` arrives translated).
 */
export function SsoSignIn({ className }: SsoSignInProps) {
  const {
    authClient,
    baseURL,
    redirectTo,
    basePaths,
    viewPaths,
    localization: coreLocalization,
    Link
  } = useAuth<SsoAuthClient>()
  const { localization } = useAuthPlugin(ssoPlugin)
  const isHydrated = useIsHydrated()

  // Read `?org=` straight from the URL (not `useSearchParams`) so the
  // statically generated `/auth/sso` page stays build-safe, matching the rest
  // of the auth UI. Only known after hydration, so the email form renders first.
  const organizationSlug = useMemo(() => {
    if (!isHydrated || typeof window === "undefined") return null
    const value = new URLSearchParams(window.location.search).get("org")?.trim()
    return value || null
  }, [isHydrated])

  const [email, setEmail] = useState("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [organizationStartFailed, setOrganizationStartFailed] = useState(false)
  // Guards the one-shot auto-start against React strict-mode's double effect.
  const organizationStartedRef = useRef(false)

  const callbackURL = `${baseURL}${redirectTo}`
  const errorCallbackURL = `${baseURL}/auth/error`

  const runSsoSignIn = useCallback(
    async (discovery: SsoDiscovery) => {
      setErrorMessage(null)
      setIsSubmitting(true)
      try {
        const result = (await authClient.signIn.sso({
          ...discovery,
          callbackURL,
          errorCallbackURL
        })) as SsoResponse
        if (result?.error) {
          setErrorMessage(result.error.message || coreLocalization.errors.generic)
          return false
        }
        // On success the better-auth client redirects the browser to the IdP.
        return true
      } catch (error) {
        setErrorMessage(
          (error instanceof Error && error.message) ||
            coreLocalization.errors.generic
        )
        return false
      } finally {
        setIsSubmitting(false)
      }
    },
    [authClient, callbackURL, errorCallbackURL, coreLocalization]
  )

  useEffect(() => {
    if (!organizationSlug || organizationStartedRef.current) return
    organizationStartedRef.current = true
    void runSsoSignIn({ organizationSlug }).then((ok) => {
      if (!ok) setOrganizationStartFailed(true)
    })
  }, [organizationSlug, runSsoSignIn])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    const trimmed = email.trim()
    // The only client-side check: non-empty and contains "@". Everything else
    // is the backend's answer.
    if (!trimmed || !trimmed.includes("@")) return
    void runSsoSignIn({ email: trimmed })
  }

  const signInHref = withRedirectTo(
    `${basePaths.auth}/${viewPaths.auth.signIn}`,
    isHydrated
  )

  const isStartingFromOrganization =
    organizationSlug !== null && !organizationStartFailed

  return (
    <Card className={cn("w-full max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-xl font-semibold">
          {localization.ssoTitle}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {isStartingFromOrganization ? (
          // Auto-starting from `?org=<slug>`: the card title already names the
          // flow, so a spinner is the whole body. On failure the email form
          // below takes over.
          <div className="flex justify-center py-6 text-muted-foreground">
            <Spinner />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <FieldDescription>{localization.ssoDescription}</FieldDescription>

            {errorMessage && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} noValidate>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="sso-email">
                    {localization.workEmail}
                  </FieldLabel>
                  <Input
                    id="sso-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    disabled={isSubmitting}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>

                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Spinner data-icon="inline-start" />}
                  {localization.continue}
                </Button>
              </FieldGroup>
            </form>

            <FieldDescription className="text-center">
              <Link
                href={signInHref}
                className="underline underline-offset-4"
              >
                {localization.backToSignIn}
              </Link>
            </FieldDescription>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
