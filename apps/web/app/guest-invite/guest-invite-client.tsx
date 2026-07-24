"use client";

import { CheckIcon, Loader2, LogIn, Users, XIcon } from "lucide-react";
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
import { authClient } from "../../lib/auth-client";
import { workspaceClient } from "../../lib/sdk";

// Where a guest lands once they have accepted and joined the workspace.
const DASHBOARD_ROUTE = "/dashboard/chat";
const INVALID_MESSAGE = "This invitation is not valid or has expired";

type AcceptStatus =
  | "loading"
  | "signed-out"
  | "accepting"
  | "accepted"
  | "error";

export function GuestInviteClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const isSignedIn = Boolean(session?.user);

  const [status, setStatus] = React.useState<AcceptStatus>("loading");
  const [message, setMessage] = React.useState<string | null>(null);
  // Guard so the accept mutation fires at most once per mount.
  const acceptedRef = React.useRef(false);

  React.useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage(INVALID_MESSAGE);
      return;
    }

    if (sessionPending) {
      setStatus("loading");
      return;
    }

    if (!isSignedIn) {
      setStatus("signed-out");
      return;
    }

    if (acceptedRef.current) {
      return;
    }
    acceptedRef.current = true;

    let cancelled = false;

    async function acceptInvitation(inviteToken: string) {
      setStatus("accepting");
      setMessage(null);
      try {
        const result = await workspaceClient.acceptGuestInvitation({
          token: inviteToken,
        });
        if (cancelled) return;
        setStatus("accepted");
        toast.success("You have joined the workspace.");
        // The backend attaches the guest to the workspace it belongs to; land
        // them in the dashboard where the active workspace resolves.
        void result.workspaceId;
        router.replace(DASHBOARD_ROUTE);
        router.refresh();
      } catch {
        if (cancelled) return;
        setStatus("error");
        setMessage(INVALID_MESSAGE);
      }
    }

    void acceptInvitation(token);

    return () => {
      cancelled = true;
    };
  }, [token, sessionPending, isSignedIn, router]);

  // Return the guest to this same page after they sign in, preserving the token.
  const signInHref = React.useMemo(() => {
    const returnTo = token
      ? `/guest-invite?token=${encodeURIComponent(token)}`
      : "/guest-invite";
    return `/auth/sign-in?redirectTo=${encodeURIComponent(returnTo)}`;
  }, [token]);

  return (
    <Card className="w-full max-w-md rounded-lg border-border/80 shadow-sm">
      <CardHeader className="gap-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
          <Logo className="h-10 w-10 rounded-lg" />
        </div>
        <div>
          <CardTitle className="text-lg">Guest invitation</CardTitle>
          <CardDescription className="mt-1">
            You have been invited to collaborate in a SourceWeft workspace.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {status === "loading" || status === "accepting" ? (
          <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {status === "accepting"
              ? "Accepting invitation..."
              : "Loading invitation..."}
          </div>
        ) : status === "signed-out" ? (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background text-foreground ring-1 ring-border">
                <Users className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  Collaborate as a guest
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  Sign in to accept your invitation.
                </div>
              </div>
            </div>
            <Button
              className="w-full"
              onClick={() => router.push(signInHref)}
              type="button"
            >
              <LogIn />
              Sign in to accept
            </Button>
          </>
        ) : status === "accepted" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
            <CheckIcon className="h-4 w-4" />
            Invitation accepted. Taking you to your workspace...
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <XIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{message ?? INVALID_MESSAGE}</span>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                router.replace(isSignedIn ? DASHBOARD_ROUTE : "/");
                router.refresh();
              }}
              type="button"
              variant="outline"
            >
              {isSignedIn ? "Go to dashboard" : "Back to home"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
