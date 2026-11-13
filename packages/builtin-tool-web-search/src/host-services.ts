import type {
  CreateHostWebProvider,
  CreateHostWebProviderInput,
} from "@sourceweft/contracts/capability-host-services";
import { AnyCrawlWebProvider } from "./providers/anycrawl";
import { DeepSeekWebProvider } from "./providers/deepseek";

const WEB_PROVIDER_NAMES = ["anycrawl", "deepseek"] as const;
type WebProviderChoice = (typeof WEB_PROVIDER_NAMES)[number];

function readEnv(env: CreateHostWebProviderInput["env"], name: string) {
  const value = env.get(name)?.trim();
  return value ? value : undefined;
}

/**
 * Which provider is configured: an explicit `WEB_PROVIDER` choice, or, when it
 * is unset, the legacy behaviour (AnyCrawl iff `ANYCRAWL_API_KEY` is set).
 * A key being present never selects a provider by itself, because the DeepSeek
 * key may exist only for the chat model Provider.
 */
function resolveChoice(env: CreateHostWebProviderInput["env"]): WebProviderChoice | null {
  const raw = readEnv(env, "WEB_PROVIDER")?.toLowerCase();
  if (raw === undefined) {
    return readEnv(env, "ANYCRAWL_API_KEY") ? "anycrawl" : null;
  }
  if ((WEB_PROVIDER_NAMES as readonly string[]).includes(raw)) {
    return raw as WebProviderChoice;
  }
  throw new Error(
    `Invalid WEB_PROVIDER "${raw}". Expected one of: ${WEB_PROVIDER_NAMES.join(", ")}.`,
  );
}

/**
 * This capability's half of the web-provider host-service contract.
 *
 * Which provider backs web search and fetch is this package's choice, and the
 * API key names are the providers'. Returning null means the web tools simply
 * do not bind. An explicitly selected provider with no credential also returns
 * null (and warns); it never falls back to the other provider.
 */
export const createHostWebProvider: CreateHostWebProvider = ({
  env,
  fetchTimeoutMs,
  logger,
}: CreateHostWebProviderInput) => {
  const choice = resolveChoice(env);
  if (choice === null) {
    return null;
  }
  const options = fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs };

  if (choice === "deepseek") {
    // `DEEPSEEK_WEB_API_KEY` lets search/fetch use a different DeepSeek
    // account; when unset the chat key is used. `DEEPSEEK_ENABLED` is the chat
    // model Provider switch and deliberately not consulted here.
    const apiKey = readEnv(env, "DEEPSEEK_WEB_API_KEY") ?? readEnv(env, "DEEPSEEK_API_KEY");
    if (!apiKey) {
      logger?.warn?.("web_provider_not_configured", {
        provider: "deepseek",
        missing: "DEEPSEEK_WEB_API_KEY or DEEPSEEK_API_KEY",
      });
      return null;
    }
    return new DeepSeekWebProvider(apiKey, options);
  }

  const apiKey = readEnv(env, "ANYCRAWL_API_KEY");
  if (!apiKey) {
    logger?.warn?.("web_provider_not_configured", {
      provider: "anycrawl",
      missing: "ANYCRAWL_API_KEY",
    });
    return null;
  }
  return new AnyCrawlWebProvider(apiKey, options);
};
