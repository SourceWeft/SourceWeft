"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import {
  hasAiDataConsent,
  recordAiDataConsent,
} from "../../../lib/ai-data-consent";
import { authClient } from "../../../lib/auth-client";
import { isIosApp, useNativeHost } from "../../../lib/native-host";

/**
 * In the iOS app, shows the dashboard only after the person has agreed to
 * their chat content being sent to third-party AI model providers. Nothing
 * behind the dialog is mounted until then, so nothing can be sent first.
 * Declining signs the person out. Everywhere else it renders its children.
 */
export function AiDataConsentGate({
  userId,
  children,
}: {
  userId: string | undefined;
  children: ReactNode;
}) {
  const host = useNativeHost();
  // The account that agreed during this visit, in case the device could not
  // store the agreement.
  const [agreedUserId, setAgreedUserId] = useState<string | null>(null);

  // Only ever true in the browser, so reading the device's storage while
  // rendering cannot disagree with the server render.
  const required = isIosApp(host) && Boolean(userId);
  if (
    !required ||
    !userId ||
    agreedUserId === userId ||
    hasAiDataConsent(userId)
  ) {
    return children;
  }

  return (
    <AiDataConsentDialog
      onAgree={() => {
        recordAiDataConsent(userId);
        setAgreedUserId(userId);
      }}
    />
  );
}

function AiDataConsentDialog({ onAgree }: { onAgree: () => void }) {
  const t = useTranslations("aiDataConsent");
  const [signingOut, setSigningOut] = useState(false);

  async function decline() {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      setSigningOut(false);
    }
  }

  function openPrivacyPolicy() {
    // A new window leaves the app for the browser; the policy is not a page
    // the app itself shows.
    window.open(
      `${window.location.origin}/privacy`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left text-sm text-muted-foreground">
              <p>{t("what")}</p>
              <p>{t("includes")}</p>
              <p>
                {t("more")}{" "}
                <button
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={openPrivacyPolicy}
                  type="button"
                >
                  {t("privacyPolicy")}
                </button>
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            disabled={signingOut}
            onClick={() => void decline()}
            type="button"
            variant="outline"
          >
            {t("decline")}
          </Button>
          <Button disabled={signingOut} onClick={onAgree} type="button">
            {t("agree")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
