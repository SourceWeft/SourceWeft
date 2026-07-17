import type { ComponentType } from "react";
import LandingV1 from "./_landing/v1";
import { MobileHomeGate } from "./mobile-home-gate";
import type { LandingAuthState } from "./_landing/components/use-landing-auth-state";

type LandingPageProps = {
  initialAuthState?: LandingAuthState;
};

// Register landing page versions here.
// Set NEXT_PUBLIC_LANDING_VERSION in .env to switch between them.
const VERSIONS: Record<string, ComponentType<LandingPageProps>> = {
  "1": LandingV1,
  // "2": LandingV2,
};

export default function RootPage() {
  const version = process.env.NEXT_PUBLIC_LANDING_VERSION ?? "1";
  const LandingPage = VERSIONS[version] ?? LandingV1;

  return (
    <MobileHomeGate>
      <LandingPage />
    </MobileHomeGate>
  );
}
