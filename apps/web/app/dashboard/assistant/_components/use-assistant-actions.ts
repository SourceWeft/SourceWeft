"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { assistantErrorCode } from "../../../../lib/assistant";

const KNOWN_ERRORS = new Set([
  "ASSISTANT_ALREADY_ENABLED",
  "ASSISTANT_FORBIDDEN",
  "ASSISTANT_NOT_FOUND",
  "ASSISTANT_TICKET_NOT_FOUND",
  "ASSISTANT_TICKET_NOT_PAYER",
  "ASSISTANT_PAUSED",
  "ASSISTANT_VERSION_CONFLICT",
]);

/**
 * Runs one assistant action and says how it went: the success toast, or the
 * refusal in words (one wording per stable error code). Resolves to whether
 * it worked.
 */
export function useAssistantAction() {
  const t = useTranslations("dashboardAssistant");

  const describe = React.useCallback(
    (error: unknown) => {
      const code = assistantErrorCode(error);
      return code && KNOWN_ERRORS.has(code)
        ? t(`errors.${code}`)
        : t("errors.generic");
    },
    [t],
  );

  const run = React.useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        toast.success(success);
        return true;
      } catch (error) {
        toast.error(describe(error));
        return false;
      }
    },
    [describe],
  );

  return { run, describe };
}
