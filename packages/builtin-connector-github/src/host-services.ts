import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createGithubConnectorAdapter } from "./adapter";
import { githubAgentToolDefs } from "./agent-tool-defs";

/** The GitHub App's URL slug: letters, digits and hyphens, as GitHub assigns
 * it (`https://github.com/apps/<slug>`). Checked after trimming and
 * lower-casing, since the help link built from it
 * (`selection-actions.ts`'s `helpLinkFor`) is lower-cased GitHub URL path
 * text. */
const APP_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  logger,
}: {
  env: CapabilityHostEnvironment;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
}): CapabilityConnectorContribution => {
  const activation = env.get("GITHUB_CONNECTOR_ENABLED")?.trim().toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("GITHUB_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  const clientId = env.get("GITHUB_CLIENT_ID")?.trim() ?? "";
  const clientSecret = env.get("GITHUB_CLIENT_SECRET")?.trim() ?? "";
  const appSlug = (env.get("GITHUB_APP_SLUG")?.trim() ?? "").toLowerCase();
  if (appSlug && !APP_SLUG_PATTERN.test(appSlug)) {
    throw new Error(
      "GITHUB_APP_SLUG must be the GitHub App's URL slug (letters, digits and hyphens)",
    );
  }
  // A missing credential is not malformed. The connector stays registered,
  // refuses to connect, and says what is missing, so it never silently
  // disappears from the catalog.
  const missing = [
    clientId ? null : "GITHUB_CLIENT_ID",
    clientSecret ? null : "GITHUB_CLIENT_SECRET",
    appSlug ? null : "GITHUB_APP_SLUG",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    logger?.warn?.("connector_not_configured", {
      connectorType: "github",
      missing,
    });
  }
  return {
    adapters: [
      createGithubConnectorAdapter({
        baseUrl: env.baseUrl,
        clientId,
        clientSecret,
        appSlug,
      }),
    ],
    agentToolDefs: [...githubAgentToolDefs],
  };
};
