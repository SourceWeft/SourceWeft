"use client"

import { useAuthPlugin } from "@better-auth-ui/react"
import { Check, Copy } from "lucide-react"
import { useId, useState } from "react"

import { Button } from "@sourceweft/ui-web/components/ui/button"
import { Label } from "@sourceweft/ui-web/components/ui/label"
import { ssoPlugin } from "@/lib/auth/sso-plugin"

export type CopyableValueProps = {
  label: string
  value: string
}

/**
 * A labelled, read-only value with a copy button. Shared by the service-provider
 * panel, the domain-verification panel and the tab's direct sign-in link.
 *
 * The label is programmatically associated with the value (`aria-labelledby`),
 * and the copy button gets a distinct accessible name ("Copy <label>") so a
 * screen reader user can tell which value each button copies. The value scrolls
 * inside its box rather than widening the surrounding table on narrow screens.
 */
export function CopyableValue({ label, value }: CopyableValueProps) {
  const { localization } = useAuthPlugin(ssoPlugin)
  const [copied, setCopied] = useState(false)
  const labelId = useId()

  async function copy() {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be blocked; the value stays visible to copy by hand.
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label id={labelId} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <code
          aria-labelledby={labelId}
          className="min-w-0 flex-1 overflow-x-auto rounded border bg-background px-2 py-1.5 font-mono text-xs whitespace-nowrap"
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={copy}
          aria-label={`${localization.orgCopy} ${label}`}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}
