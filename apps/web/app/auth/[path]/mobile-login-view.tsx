"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Apple,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Logo } from "@sourceweft/ui-web/logo";
import { authClient } from "../../../lib/auth-client";
import {
  trackAuthError,
  trackLogin,
  trackSignUp,
} from "../../../lib/analytics-events";
import {
  getMobileGoogleSignInError,
  signInWithMobileGoogle,
} from "../../../lib/mobile-google-auth";

type MobileAuthMode = "sign-in" | "sign-up";

type AuthResult = {
  error?: {
    message?: string | null;
  } | null;
};

type SessionResult = {
  data?: {
    session?: unknown;
    user?: unknown;
  } | null;
  session?: unknown;
  user?: unknown;
};

type MobileAuthNotice = {
  message: string;
  variant: "error" | "success";
};

function resolveInitialMode(path: string): MobileAuthMode {
  return path === "sign-up" ? "sign-up" : "sign-in";
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

function getAuthResultError(result: unknown) {
  const error = (result as AuthResult | null)?.error;
  return error?.message || null;
}

function hasActiveSession(result: unknown) {
  const sessionResult = result as SessionResult | null;
  const data = sessionResult?.data;
  return Boolean(
    data?.session || data?.user || sessionResult?.session || sessionResult?.user,
  );
}

export function MobileLoginView({ path }: { path: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<MobileAuthMode>(() =>
    resolveInitialMode(path),
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<MobileAuthNotice | null>(null);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function redirectIfSignedIn() {
      try {
        const session = await authClient.getSession();
        if (!isMounted || !hasActiveSession(session)) {
          return;
        }

        router.replace("/dashboard");
        router.refresh();
      } catch {
        // Stay on the mobile auth form when the session probe is unavailable.
      }
    }

    void redirectIfSignedIn();

    return () => {
      isMounted = false;
    };
  }, [router]);

  const copy = useMemo(() => {
    if (mode === "sign-up") {
      return {
        title: "Create account",
        description: "Start doing your best work with SourceWeft",
        submit: "Create account",
        alternatePrompt: "Already have an account?",
        alternateAction: "Sign in",
      };
    }

    return {
      title: "Sign in",
      description: "Do your best work with SourceWeft",
      submit: "Sign in",
      alternatePrompt: "New to SourceWeft?",
      alternateAction: "Create account",
    };
  }, [mode]);

  function switchMode(nextMode: MobileAuthMode) {
    setMode(nextMode);
    setNotice(null);
  }

  async function completeAuthSuccess(source: MobileAuthMode | "google") {
    const session = await authClient.getSession();

    if (hasActiveSession(session)) {
      router.replace("/dashboard");
      router.refresh();
      return;
    }

    if (source === "sign-up") {
      setMode("sign-in");
      setPassword("");
      setNotice({
        message:
          "Account created, but we could not start your session. Please sign in.",
        variant: "success",
      });
      return;
    }

    setNotice({
      message: "Signed in, but your session was not available. Please try again.",
      variant: "error",
    });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || isGoogleSubmitting) {
      return;
    }

    setNotice(null);
    setIsSubmitting(true);

    try {
      const normalizedEmail = email.trim();
      const normalizedName = name.trim();

      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({
              name: normalizedName,
              email: normalizedEmail,
              password,
            })
          : await authClient.signIn.email({
              email: normalizedEmail,
              password,
            });

      const resultError = getAuthResultError(result);
      if (resultError) {
        trackAuthError({
          action: mode === "sign-up" ? "sign_up" : "login",
          method: "email",
          surface: "mobile",
        });
        setNotice({ message: resultError, variant: "error" });
        return;
      }

      if (mode === "sign-up") {
        trackSignUp("email");
      } else {
        trackLogin("email");
      }
      await completeAuthSuccess(mode);
    } catch (caughtError) {
      trackAuthError({
        action: mode === "sign-up" ? "sign_up" : "login",
        method: "email",
        surface: "mobile",
      });
      setNotice({
        message: getErrorMessage(
          caughtError,
          mode === "sign-up"
            ? "Unable to create your account. Check your details and try again."
            : "Unable to sign in. Check your email and password and try again.",
        ),
        variant: "error",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitGoogleSignIn() {
    if (isSubmitting || isGoogleSubmitting) {
      return;
    }

    setNotice(null);
    setIsGoogleSubmitting(true);

    try {
      await signInWithMobileGoogle();
      trackLogin("mobile_google");
      await completeAuthSuccess("google");
    } catch (caughtError) {
      trackAuthError({
        action: "login",
        method: "mobile_google",
        surface: "mobile",
      });
      const message = getMobileGoogleSignInError(caughtError);
      if (message) {
        setNotice({ message, variant: "error" });
      }
    } finally {
      setIsGoogleSubmitting(false);
    }
  }

  const isSignUp = mode === "sign-up";
  const formDisabled = isSubmitting || isGoogleSubmitting;

  return (
    <div className="flex h-[calc(100svh-2rem)] w-full max-w-md flex-col overflow-y-auto overscroll-contain px-1 [-webkit-overflow-scrolling:touch]">
      <div className="flex min-h-full flex-col py-[max(1.5rem,env(safe-area-inset-top),env(safe-area-inset-bottom))] [@media(max-height:760px)]:py-4">
        <div className="my-auto w-full">
          <div className="mb-7 flex flex-col items-center text-center [@media(max-height:760px)]:mb-4">
            <div className="mb-4 flex items-center gap-2.5 [@media(max-height:760px)]:mb-3">
              <Logo className="h-8 w-8 rounded-lg [@media(max-height:760px)]:h-7 [@media(max-height:760px)]:w-7" />
              <span className="text-[1.7rem] font-semibold tracking-normal text-foreground [@media(max-height:760px)]:text-2xl">
                SourceWeft
              </span>
            </div>
            <h1 className="max-w-72 text-balance text-[1.7rem] font-medium leading-tight tracking-normal text-foreground [@media(max-height:760px)]:text-2xl">
              {copy.description}
            </h1>
          </div>

          <div
            className="space-y-2.5 [@media(max-height:680px)]:hidden"
          >
            <button
              className="flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-foreground px-5 text-sm font-semibold text-background shadow-sm transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
              disabled={formDisabled}
              onClick={() => void submitGoogleSignIn()}
              type="button"
            >
              {isGoogleSubmitting ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <span className="flex size-5 items-center justify-center rounded-full bg-background text-sm font-bold text-foreground">
                  G
                </span>
              )}
              Continue with Google
            </button>

            <button
              className="flex h-12 w-full cursor-not-allowed items-center justify-center gap-2.5 rounded-full bg-foreground px-5 text-sm font-semibold text-background opacity-35 shadow-sm"
              disabled
              tabIndex={-1}
              type="button"
            >
              <Apple className="size-[18px] fill-current" />
              Continue with Apple
            </button>
          </div>

          <div className="my-5 flex items-center gap-5 [@media(max-height:760px)]:my-3 [@media(max-height:680px)]:hidden">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-semibold text-muted-foreground">
              OR
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form
            className="space-y-2.5 [@media(max-height:760px)]:space-y-2"
            onSubmit={(event) => void submitForm(event)}
          >
            {isSignUp && (
              <Input
                autoComplete="name"
                className="h-12 rounded-full border-border bg-background px-5 text-center text-sm shadow-none placeholder:text-muted-foreground/55 [@media(max-height:760px)]:h-11"
                disabled={formDisabled}
                id="mobile-auth-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Full name"
                required
                value={name}
              />
            )}

            <Input
              autoComplete="email"
              className="h-12 rounded-full border-border bg-background px-5 text-center text-sm shadow-none placeholder:text-muted-foreground/55 [@media(max-height:760px)]:h-11"
              disabled={formDisabled}
              id="mobile-auth-email"
              inputMode="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Personal or work email"
              required
              type="email"
              value={email}
            />

            <Input
              autoComplete={isSignUp ? "new-password" : "current-password"}
              className="h-12 rounded-full border-border bg-background px-5 text-center text-sm shadow-none placeholder:text-muted-foreground/55 [@media(max-height:760px)]:h-11"
              disabled={formDisabled}
              id="mobile-auth-password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              required
              type="password"
              value={password}
            />

            {notice && (
              <Alert
                className="rounded-2xl"
                variant={
                  notice.variant === "error" ? "destructive" : "default"
                }
              >
                {notice.variant === "error" ? <AlertCircle /> : <CheckCircle2 />}
                <AlertDescription>{notice.message}</AlertDescription>
              </Alert>
            )}

            <Button
              className="h-12 w-full rounded-full text-sm font-semibold [@media(max-height:760px)]:h-11"
              disabled={formDisabled}
              size="lg"
              type="submit"
            >
              {isSubmitting && <Loader2 className="animate-spin" />}
              {copy.submit}
            </Button>
          </form>

          <div className="mt-4 flex items-center justify-center gap-1.5 text-sm text-muted-foreground [@media(max-height:760px)]:mt-2">
            {isSignUp ? (
              <>
                <Button
                  disabled={formDisabled}
                  onClick={() => switchMode("sign-in")}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ArrowLeft />
                  {copy.alternateAction}
                </Button>
              </>
            ) : (
              <>
                <span>{copy.alternatePrompt}</span>
                <Button
                  disabled={formDisabled}
                  onClick={() => switchMode("sign-up")}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  {copy.alternateAction}
                </Button>
              </>
            )}
          </div>

          <p className="mt-3 text-center text-xs text-muted-foreground [@media(max-height:760px)]:mt-2 [@media(max-height:680px)]:hidden">
            Apple sign-in is coming soon.
          </p>

          <p className="mt-6 px-5 text-center text-xs leading-5 text-muted-foreground [@media(max-height:760px)]:mt-3 [@media(max-height:680px)]:px-2 [@media(max-height:680px)]:leading-4">
            By continuing, you agree to SourceWeft&apos;s{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href="/terms"
            >
              Terms
            </a>{" "}
            and acknowledge our{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href="/privacy"
            >
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
