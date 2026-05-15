import type { ComponentType } from "react";
import { headers } from "next/headers";
import LandingV1 from "./_landing/v1";
import type {
  LandingAuthState,
  LandingAuthUser,
} from "./_landing/components/use-landing-auth-state";

type LandingPageProps = {
  initialAuthState?: LandingAuthState;
};

// Register landing page versions here.
// Set NEXT_PUBLIC_LANDING_VERSION in .env to switch between them.
const VERSIONS: Record<string, ComponentType<LandingPageProps>> = {
  "1": LandingV1,
  // "2": LandingV2,
};

function resolveAuthSessionUrl() {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
  return `${base.replace(/\/$/, "")}/api/auth/get-session`;
}

async function resolveInitialAuthState(): Promise<LandingAuthState> {
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

export default async function RootPage() {
  const version = process.env.NEXT_PUBLIC_LANDING_VERSION ?? "1";
  const LandingPage = VERSIONS[version] ?? LandingV1;
  const initialAuthState = await resolveInitialAuthState();

  return <LandingPage initialAuthState={initialAuthState} />;
}
