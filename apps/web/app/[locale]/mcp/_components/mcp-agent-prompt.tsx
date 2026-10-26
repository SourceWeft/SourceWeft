import { useTranslations } from "next-intl";

import { CopyButton } from "./mcp-client";
import { mcpInstallGuidePath } from "./mcp-paths";

/**
 * "Use with an agent": a prompt that sends any coding agent (or SourceWeft
 * chat) to this server's install guide, which shows the user the publisher,
 * endpoint and sign-in before it changes a config. The guide itself is one
 * English file, linked and never sniffed.
 */
export function McpAgentPrompt({
  className,
  identifier,
  siteUrl,
}: {
  className?: string;
  identifier: string;
  siteUrl: string;
}) {
  const t = useTranslations("mcp.detail");
  const guidePath = mcpInstallGuidePath(identifier);
  const prompt = t("agentPrompt", { url: `${siteUrl}${guidePath}` });
  return (
    <div className={className} data-testid="mcp-agent-prompt">
      <h3 className="font-semibold">{t("agentHeading")}</h3>
      <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {t("agentLead")}
      </p>
      <div className="mt-3 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-words rounded-lg bg-zinc-100 px-3 py-2 text-xs leading-5 text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
          {prompt}
        </code>
        <CopyButton
          className="h-8 shrink-0 px-2"
          copiedLabel={t("copied")}
          failedLabel={t("copyFailed")}
          label={t("copy")}
          value={prompt}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-zinc-500">
        {/* Not a LocaleLink: the guide is one English file, with no locale prefix. */}
        <a
          className="underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 hover:decoration-zinc-950 dark:decoration-white/20 dark:hover:text-white"
          href={guidePath}
          rel="nofollow"
        >
          {t("agentGuideLink")}
        </a>
      </p>
    </div>
  );
}
