"use client";

import { authClient } from "../../../lib/auth-client";

export type LandingAuthUser = {
  email?: string | null;
  name?: string | null;
};

export type LandingAuthState = {
  isPending: boolean;
  isSignedIn: boolean;
  user: LandingAuthUser | null;
};

type SessionData = {
  session?: unknown;
  user?: LandingAuthUser | null;
};

export function getLandingUserLabel(user: LandingAuthUser | null) {
  return user?.name || user?.email || "Signed in";
}

export function useLandingAuthState(
  initialState?: LandingAuthState,
): LandingAuthState {
  const { data, isPending } = authClient.useSession();
  const sessionData = data as SessionData | null | undefined;
  const user = sessionData?.user ?? null;

  if (isPending && initialState) {
    return initialState;
  }

  return {
    isPending,
    isSignedIn: Boolean(sessionData?.session || user),
    user,
  };
}
