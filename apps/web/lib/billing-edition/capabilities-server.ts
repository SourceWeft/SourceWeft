import "server-only";

import { unstable_cache } from "next/cache";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";

import { deploymentClient } from "../sdk";

const CAPABILITIES_REVALIDATE_SECONDS = 300;

const cachedCapabilities = unstable_cache(
  async () => deploymentClient.getCapabilities(),
  ["deployment-capabilities"],
  { revalidate: CAPABILITIES_REVALIDATE_SECONDS },
);

/**
 * Seeds the client provider so capability-gated marketing content (pricing) is
 * in the server HTML instead of appearing after a browser round-trip. Returns
 * null on failure so the client falls back to fetching them itself.
 */
export async function resolveDeploymentCapabilities(): Promise<DeploymentCapabilities | null> {
  try {
    return await cachedCapabilities();
  } catch {
    return null;
  }
}
