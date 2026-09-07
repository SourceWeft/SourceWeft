"use client";

import { useSyncExternalStore } from "react";
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

const pendingAuthState: LandingAuthState = {
  isPending: true,
  isSignedIn: false,
  user: null,
};
const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function getLandingUserLabel(user: LandingAuthUser | null) {
  return user?.name || user?.email || "Signed in";
}

export function useLandingAuthState(
  initialState?: LandingAuthState,
): LandingAuthState {
  const { data, isPending } = authClient.useSession();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientSnapshot,
    serverSnapshot,
  );
  const sessionData = data as SessionData | null | undefined;
  const user = sessionData?.user ?? null;

  // The session store may finish before this component hydrates. Its first
  // client render must still match the HTML, then follow the live session.
  if (!hydrated) return initialState ?? pendingAuthState;

  if (isPending && initialState) {
    return initialState;
  }

  return {
    isPending,
    isSignedIn: Boolean(sessionData?.session || user),
    user,
  };
}
