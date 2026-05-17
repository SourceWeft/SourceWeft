"use client";

import { useAuthenticate } from "@daveyplate/better-auth-ui";
import { CheckIcon, Loader2, MailCheck, XIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sourceweft/ui-web/components/ui/card";
import { Logo } from "@sourceweft/ui-web/logo";
import { trackTeamInvitationAccepted } from "../../../lib/analytics-events";
import { authClient } from "../../../lib/auth-client";

type InvitationRecord = {
  email?: string | null;
  expiresAt?: Date | string | null;
  id: string;
  organizationId: string;
  organizationName?: string | null;
  organizationSlug?: string | null;
  role?: string | null;
  status?: string | null;
};

type AcceptInvitationResult = {
  invitation?: InvitationRecord | null;
  member?: unknown;
};

type AuthEnvelope<T> = {
  data?: T | null;
  error?: { message?: string } | null;
};

type InviteStatus =
  | "loading"
  | "ready"
  | "accepting"
  | "rejecting"
  | "accepted"
  | "rejected"
  | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapAuthResult<T>(
  result: T | AuthEnvelope<T>,
  fallbackMessage: string,
): T {
  if (isRecord(result) && ("data" in result || "error" in result)) {
    const envelope = result as AuthEnvelope<T>;
    if (envelope.error) {
      throw new Error(envelope.error.message ?? fallbackMessage);
    }

    if (envelope.data == null) {
      throw new Error(fallbackMessage);
    }

    return envelope.data;
  }

  return result as T;
}

function getErrorMessage(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  if (
    isRecord(error) &&
    isRecord(error.error) &&
    typeof error.error.message === "string"
  ) {
    return error.error.message;
  }

  return fallbackMessage;
}

function getSafeRedirectTo(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }

  return value;
}

function isExpired(expiresAt: InvitationRecord["expiresAt"]) {
  if (!expiresAt) {
    return false;
  }

  return new Date(expiresAt).getTime() < Date.now();
}

function formatRole(role: string | null | undefined) {
  if (!role) {
    return "Member";
  }

  return role
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(", ");
}

export function AcceptInvitationClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const redirectTo = getSafeRedirectTo(searchParams.get("redirectTo"));
  const authState = useAuthenticate({ enabled: Boolean(invitationId) });
  const { refetch: refetchSession } = authClient.useSession();
  const { refetch: refetchOrganizations } = authClient.useListOrganizations();
  const { refetch: refetchActiveOrganization } =
    authClient.useActiveOrganization();
  const [invitation, setInvitation] = React.useState<InvitationRecord | null>(
    null,
  );
  const [status, setStatus] = React.useState<InviteStatus>("loading");
  const [message, setMessage] = React.useState<string | null>(null);

  const refreshOrganizationState = React.useCallback(
    async (organizationId?: string | null) => {
      if (organizationId) {
        await authClient.organization
          .setActive({
            organizationId,
            fetchOptions: { throw: true },
          })
          .catch(() => null);
      }

      await Promise.all([
        refetchSession().catch(() => null),
        refetchActiveOrganization().catch(() => null),
        refetchOrganizations().catch(() => null),
      ]);
    },
    [refetchActiveOrganization, refetchOrganizations, refetchSession],
  );

  React.useEffect(() => {
    if (!invitationId) {
      setStatus("error");
      setMessage("Invitation link is missing.");
      return;
    }

    if (authState.isPending || !authState.data) {
      setStatus("loading");
      return;
    }

    let cancelled = false;

    async function loadInvitation() {
      setStatus("loading");
      setMessage(null);

      try {
        const result = await authClient.organization.getInvitation({
          query: { id: invitationId },
          fetchOptions: { throw: true },
        });
        const nextInvitation = unwrapAuthResult<InvitationRecord>(
          result,
          "Invitation not found.",
        );

        if (cancelled) {
          return;
        }

        if (
          nextInvitation.status !== "pending" ||
          isExpired(nextInvitation.expiresAt)
        ) {
          if (
            nextInvitation.status === "accepted" &&
            !isExpired(nextInvitation.expiresAt)
          ) {
            await refreshOrganizationState(nextInvitation.organizationId);

            if (cancelled) {
              return;
            }

            setInvitation(nextInvitation);
            setStatus("accepted");
            router.replace(redirectTo);
            router.refresh();
            return;
          }

          setInvitation(nextInvitation);
          setStatus("error");
          setMessage(
            isExpired(nextInvitation.expiresAt)
              ? "This invitation has expired."
              : "This invitation is no longer pending.",
          );
          return;
        }

        setInvitation(nextInvitation);
        setStatus("ready");
      } catch (error) {
        await refreshOrganizationState(null);

        if (cancelled) {
          return;
        }

        setStatus("error");
        setMessage(getErrorMessage(error, "Invitation not found."));
      }
    }

    void loadInvitation();

    return () => {
      cancelled = true;
    };
  }, [
    authState.data,
    authState.isPending,
    invitationId,
    redirectTo,
    refreshOrganizationState,
    router,
  ]);

  async function handleAccept() {
    if (!invitationId) {
      return;
    }

    setStatus("accepting");
    setMessage(null);

    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId,
        fetchOptions: { throw: true },
      });
      const accepted = unwrapAuthResult<AcceptInvitationResult>(
        result,
        "Failed to accept invitation.",
      );
      const organizationId =
        accepted.invitation?.organizationId ?? invitation?.organizationId;

      await refreshOrganizationState(organizationId);

      trackTeamInvitationAccepted();
      setStatus("accepted");
      toast.success("Invitation accepted.");
      router.replace(redirectTo);
      router.refresh();
    } catch (error) {
      await refreshOrganizationState(invitation?.organizationId ?? null);
      setStatus("error");
      setMessage(getErrorMessage(error, "Failed to accept invitation."));
    }
  }

  async function handleReject() {
    if (!invitationId) {
      return;
    }

    setStatus("rejecting");
    setMessage(null);

    try {
      const result = await authClient.organization.rejectInvitation({
        invitationId,
        fetchOptions: { throw: true },
      });

      unwrapAuthResult<unknown>(result, "Failed to reject invitation.");
      await refreshOrganizationState(null);

      setStatus("rejected");
      toast.success("Invitation declined.");
      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      setStatus("error");
      setMessage(getErrorMessage(error, "Failed to reject invitation."));
    }
  }

  const isProcessing = status === "accepting" || status === "rejecting";
  const orgName = invitation?.organizationName ?? "SourceWeft team";

  return (
    <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
      <CardHeader className="gap-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
          <Logo className="h-10 w-10 rounded-lg" />
        </div>
        <div>
          <CardTitle className="text-lg">Accept invitation</CardTitle>
          <CardDescription className="mt-1">
            Join the team workspace in SourceWeft.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {status === "loading" ? (
          <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading invitation...
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background text-foreground ring-1 ring-border">
                <MailCheck className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {orgName}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {formatRole(invitation?.role)}
                  {invitation?.email ? ` for ${invitation.email}` : ""}
                </div>
              </div>
            </div>

            {message ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {message}
              </p>
            ) : null}

            {status === "ready" ||
            status === "accepting" ||
            status === "rejecting" ? (
              <div className="grid grid-cols-2 gap-3">
                <Button
                  disabled={isProcessing}
                  onClick={() => void handleReject()}
                  type="button"
                  variant="outline"
                >
                  {status === "rejecting" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <XIcon />
                  )}
                  Decline
                </Button>
                <Button
                  disabled={isProcessing}
                  onClick={() => void handleAccept()}
                  type="button"
                >
                  {status === "accepting" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <CheckIcon />
                  )}
                  Accept
                </Button>
              </div>
            ) : (
              <Button
                className="w-full"
                onClick={() => {
                  router.replace("/dashboard");
                  router.refresh();
                }}
                type="button"
              >
                Go to dashboard
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
