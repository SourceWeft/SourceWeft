"use client";

import { ExternalLink } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  mcpEndpointHost,
  type McpPublicFacts,
} from "../../../../lib/mcp-facts";
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
  const locale = useLocale();
  const tTemplate = useTranslations("mcp.template");
  // Only what the top card and the badges do not already say: transport,
  // auth, tool count and the repository/homepage links are all there.
  const rows: Array<{
    key: string;
    label: string;
    value: React.ReactNode;
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
    ...(facts.documentationUrl
      ? [
          {
            key: "documentation",
            label: t("documentation"),
            value: <FactLink href={facts.documentationUrl} />,
          },
        ]
      : []),
    ...(facts.probedAt
      ? [
          {
            key: "probed",
            label: t("probed"),
            value: (
              <time dateTime={facts.probedAt}>{new Intl.DateTimeFormat(locale, {
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                  year: "numeric",
                }).format(new Date(facts.probedAt))}</time>
            ),
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
      {rows.length > 0 ? (
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {rows.map((row) => (
            <div className="min-w-0" data-fact={row.key} key={row.key}>
              <dt className="text-xs text-zinc-500">{row.label}</dt>
              <dd className="mt-1 break-words font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
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
