"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  mcpEndpointHost,
  type McpPublicFacts,
} from "../../../../lib/mcp-facts";
import { transportLabel } from "../../../../lib/mcp-labels";
import { mcpTemplateDescription } from "../../../../lib/mcp-template-description";

/**
 * What stands in the Overview section of a public MCP page that has no AI
 * overview (#367 W4): the template sentence, then the facts it was built
 * from and the links the entry declares. Nothing here is inferred — every
 * row is a manifest field, a registry field, or what the server said about
 * itself — so a server the overview rule skips still has a section that
 * says what it is. The documentation link is shown, never fetched.
 */
export function McpFactsPanel({
  className,
  facts,
}: {
  className?: string;
  facts: McpPublicFacts;
}) {
  const t = useTranslations("mcp.facts");
  const tAuth = useTranslations("mcp.authMethod");
  const tTemplate = useTranslations("mcp.template");
  const rows: Array<{
    key: string;
    label: string;
    value: React.ReactNode;
    note?: string;
  }> = [
    ...(facts.publisherDomain
      ? [
          {
            key: "publisher",
            label: t("publisher"),
            value: facts.publisherDomain,
          },
        ]
      : []),
    ...(facts.endpointHost
      ? [{ key: "endpoint", label: t("endpoint"), value: facts.endpointHost }]
      : []),
    {
      key: "transport",
      label: t("transport"),
      value: transportLabel(facts.transport),
    },
    {
      key: "auth",
      label: t("auth"),
      value: tAuth(facts.authMethod),
      note: tAuth(
        `explain.${facts.authExplanation.key}`,
        facts.authExplanation.values,
      ),
    },
    ...(facts.toolCount > 0
      ? [
          {
            key: "tools",
            label: t("tools"),
            value: t("toolsCount", { count: facts.toolCount }),
          },
        ]
      : []),
    ...(facts.documentationUrl
      ? [
          {
            key: "documentation",
            label: t("documentation"),
            value: <FactLink href={facts.documentationUrl} />,
          },
        ]
      : []),
    ...(facts.repoUrl
      ? [
          {
            key: "repository",
            label: t("repository"),
            value: <FactLink href={facts.repoUrl} />,
          },
        ]
      : []),
    ...(facts.homepageUrl
      ? [
          {
            key: "homepage",
            label: t("homepage"),
            value: <FactLink href={facts.homepageUrl} />,
          },
        ]
      : []),
  ];
  return (
    <section
      aria-label={t("title")}
      className={className}
      data-testid="mcp-facts-panel"
    >
      <p className="text-sm leading-7 text-zinc-700 dark:text-zinc-200">
        {mcpTemplateDescription(facts, (key, values) =>
          tTemplate(key as never, values as never),
        )}
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {t("lead")}
      </p>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {rows.map((row) => (
          <div className="min-w-0" data-fact={row.key} key={row.key}>
            <dt className="text-xs text-zinc-500">{row.label}</dt>
            <dd className="mt-1 break-words font-medium">{row.value}</dd>
            {row.note ? (
              <dd className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {row.note}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A declared link, shown by its host: third-party, so no follow, no referrer. */
function FactLink({ href }: { href: string }) {
  return (
    <a
      className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-950 dark:text-white dark:decoration-white/20 dark:hover:decoration-white"
      href={href}
      rel="nofollow noopener noreferrer"
      target="_blank"
    >
      {mcpEndpointHost(href) ?? href}
      <ExternalLink className="size-3.5" />
    </a>
  );
}
