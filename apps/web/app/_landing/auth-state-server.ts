import "server-only";
import { internalApiBaseUrl } from "../../lib/internal-api-base-url";

import { headers } from "next/headers";

import type {
  LandingAuthState,
  LandingAuthUser,
} from "./components/use-landing-auth-state";

function resolveAuthSessionUrl() {
  const base = internalApiBaseUrl();
  return `${base.replace(/\/$/, "")}/api/auth/get-session`;
}

export async function resolveInitialLandingAuthState(): Promise<LandingAuthState> {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get("cookie");

  if (!cookieHeader) {
    return {
      isPending: false,
      isSignedIn: false,
      user: null,
    };
  }

  try {
    const response = await fetch(resolveAuthSessionUrl(), {
      cache: "no-store",
      headers: {
        cookie: cookieHeader,
      },
    });

    if (!response.ok) {
      return {
        isPending: false,
        isSignedIn: false,
        user: null,
      };
    }

    const data = (await response.json()) as {
      session?: unknown;
      user?: LandingAuthUser | null;
    } | null;
    const user = data?.user ?? null;

    return {
      isPending: false,
      isSignedIn: Boolean(data?.session || user),
      user,
    };
  } catch {
    return {
      isPending: false,
      isSignedIn: false,
      user: null,
    };
  }
}
