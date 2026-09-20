import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Code2,
  ExternalLink,
  Globe2,
  KeyRound,
  Laptop,
  Plug,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import type {
  MarketCategory,
  MarketItemSummary,
  MarketMcpManifest,
  MarketMcpToolManifest,
  McpRiskLevel,
  McpRuntime,
  McpTransport,
} from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";
import { slugify } from "../../../../lib/slug";

import { McpIcon } from "./mcp-client";

export const mcpContainerClassName = "max-w-7xl px-5 sm:px-6 lg:px-8";

// FAQ copy lives in the `mcp.faq.items` catalog; these keys drive both the
// rendered section and the FAQPage JSON-LD so structured data matches the
// visible, localized text.
export const mcpFaqKeys = ["what", "use", "safe", "transport", "keys"] as const;

export function mcpCategoryPath(slug: string) {
  return `/mcp/category/${encodeURIComponent(slug)}`;
}

export function mcpCategoryNames(categories: MarketCategory[]) {
  return new Map(categories.map((category) => [category.slug, category.name]));
}

export function mcpCategoryLabel(
  slug: string,
  names?: ReadonlyMap<string, string>,
) {
  return (
    names?.get(slug) ??
    slug
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function mcpPath(identifier: string) {
  return `/mcp/${encodeURIComponent(identifier)}`;
}

export function slugifyAnchor(value: string) {
  return slugify(value);
}

export function verificationLabel(item: {
  official?: boolean;
  verified?: boolean;
}) {
  if (item.official) {
    return "Official";
  }
  return item.verified ? "Verified" : "Unverified";
}

export function runtimeLabel(item: {
  desktopOnly?: boolean;
  runtime?: McpRuntime;
  webExecutable?: boolean;
}) {
  if (item.runtime === "hybrid") {
    return "Web + Desktop";
  }
  if (item.runtime === "desktop" || item.desktopOnly || !item.webExecutable) {
    return "Desktop only";
  }
  return "Web executable";
}

export function transportLabel(transport?: McpTransport | null) {
  if (transport === "streamable_http") {
    return "Streamable HTTP";
  }
  if (transport === "http_sse_compat") {
    return "HTTP/SSE";
  }
  if (transport === "sse") {
    return "SSE";
  }
  if (transport === "stdio") {
    return "STDIO";
  }
  return "MCP";
}

export function riskLabel(risk: McpRiskLevel) {
  if (risk === "read") return "Read";
  if (risk === "write") return "Write";
  if (risk === "destructive") return "Destructive";
  return "Unknown";
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "dark";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        tone === "good" &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-200",
        tone === "warn" &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-200",
        tone === "dark" &&
          "border-zinc-950 bg-zinc-950 text-white dark:border-white dark:bg-white dark:text-zinc-950",
        tone === "neutral" &&
          "border-zinc-300 bg-white/70 text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

export async function McpVerificationBadge({
  item,
}: {
  item: { official?: boolean; verified?: boolean };
}) {
  const t = await getTranslations("mcp.badges.verification");
  if (item.official) {
    return (
      <Badge tone="dark">
        <ShieldCheck className="size-3.5" />
        {t("official")}
      </Badge>
    );
  }
  if (item.verified) {
    return (
      <Badge tone="good">
        <CheckCircle2 className="size-3.5" />
        {t("verified")}
      </Badge>
    );
  }
  return (
    <Badge tone="warn">
      <AlertTriangle className="size-3.5" />
      {t("unverified")}
    </Badge>
  );
}

export async function McpRuntimeBadge({
  item,
}: {
  item: {
    desktopOnly?: boolean;
    runtime?: McpRuntime;
    webExecutable?: boolean;
  };
}) {
  const t = await getTranslations("mcp.badges.runtime");
  const desktop =
    item.runtime === "desktop" || item.desktopOnly || !item.webExecutable;
  const key = item.runtime === "hybrid" ? "hybrid" : desktop ? "desktop" : "web";
  return (
    <Badge>
      {desktop ? <Laptop className="size-3.5" /> : <Globe2 className="size-3.5" />}
      {t(key)}
    </Badge>
  );
}

export function McpTransportBadge({
  transport,
}: {
  transport?: McpTransport | null;
}) {
  return (
    <Badge>
      {transport === "stdio" ? (
        <TerminalSquare className="size-3.5" />
      ) : (
        <Plug className="size-3.5" />
      )}
      {transportLabel(transport)}
    </Badge>
  );
}

export function formatDate(value?: string | null) {
  if (!value) return "Unscheduled";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export function shortSeoText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function mcpDetailSeoDescription(input: {
  item: MarketItemSummary;
  manifest: MarketMcpManifest;
}) {
  const categoryText =
    input.item.categories.length > 0
      ? input.item.categories
          .slice(0, 3)
          .map((slug) => mcpCategoryLabel(slug))
          .join(", ")
      : "AI tool";
  const tools = input.manifest.tools
    .map((tool) => tool.title || tool.name)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  const toolsText = tools ? ` including ${tools}` : "";
  return shortSeoText(
    `Use ${input.item.name} as an MCP server for ${categoryText} workflows${toolsText}. View tools, transport, runtime, auth requirements, and safety notes.`,
    180,
  );
}

export async function McpMarketCard({
  categoryNames,
  highlightCategory,
  item,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  /** Category to show when the item has several, e.g. the one being browsed. */
  highlightCategory?: string;
  item: MarketItemSummary;
}) {
  const t = await getTranslations("mcp.card");
  const trusted = Boolean(item.official || item.verified);
  const primaryCategory =
    highlightCategory && item.categories.includes(highlightCategory)
      ? highlightCategory
      : item.categories[0];
  return (
    <Link
      className="group flex h-full flex-col rounded-xl border border-zinc-300 bg-white/62 p-5 transition-all hover:-translate-y-0.5 hover:border-zinc-950/40 hover:bg-white hover:shadow-[0_18px_70px_rgba(39,39,42,0.1)] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
      href={mcpPath(item.identifier)}
    >
      <div className="flex items-start gap-3">
        <McpIcon iconUrl={item.iconUrl} trusted={trusted} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold leading-6 text-zinc-950 dark:text-white">
            {item.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-zinc-500">


            {item.providerName ?? item.identifier}
          </p>
        </div>
        <McpVerificationBadge item={item} />
      </div>

      <p className="mt-4 line-clamp-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {item.summary}
      </p>

      <div className="mb-4 mt-4 flex flex-wrap gap-2">
        <McpTransportBadge transport={item.transport} />
        <McpRuntimeBadge item={item} />
        {item.requiresAuth ? (
          <Badge>
            <KeyRound className="size-3.5" />
            {t("auth")}
          </Badge>
        ) : null}
      </div>

      <div className="mt-auto flex items-center gap-x-4 gap-y-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-white/10">
        {primaryCategory ? (
          <span className="min-w-0 truncate">
            {mcpCategoryLabel(primaryCategory, categoryNames)}
          </span>
        ) : null}
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Code2 className="size-3.5" />
          {t("tools", { count: item.toolsCount })}
        </span>
        <span className="ml-auto shrink-0">{formatDate(item.updatedAt)}</span>
      </div>
    </Link>
  );
}

export function McpCardGrid({
  categoryNames,
  className,
  highlightCategory,
  items,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  className?: string;
  highlightCategory?: string;
  items: MarketItemSummary[];
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {items.map((item) => (
        <McpMarketCard
          categoryNames={categoryNames}
          highlightCategory={highlightCategory}
          item={item}
          key={item.identifier}
        />
      ))}
    </div>
  );
}

export async function McpDirectorySection({
  categoryNames,
  description,
  highlightCategory,
  items,
  title,
  viewAllHref,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  description: string;
  highlightCategory?: string;
  items: MarketItemSummary[];
  title: string;
  viewAllHref: string;
}) {
  if (items.length === 0) {
    return null;
  }
  const t = await getTranslations("mcp.card");
  return (
    <section>
      <div className="mb-5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            {title}
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        </div>
        <Link
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          href={viewAllHref}
        >
          {t("viewAll")}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <McpCardGrid
        categoryNames={categoryNames}
        highlightCategory={highlightCategory}
        items={items}
      />
    </section>
  );
}

export async function McpToolRows({
  tools,
}: {
  tools: MarketMcpToolManifest[];
}) {
  const t = await getTranslations("mcp");
  if (tools.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-300 bg-white/52 p-5 text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
        {t("tools.empty")}
      </div>
    );
  }

  return (
    <div className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-300 bg-white/58 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {tools.map((tool) => (
        <article className="scroll-mt-24 p-4" id={`tool-${slugifyAnchor(tool.name)}`} key={tool.name}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">
                {tool.name}
              </h3>
              {tool.title ? (
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {tool.title}
                </p>
              ) : null}
            </div>
            <Badge
              tone={
                tool.risk === "read"
                  ? "good"
                  : tool.risk === "unknown"
                    ? "neutral"
                    : "warn"
              }
            >
              {t(
                `badges.risk.${
                  tool.risk === "read" ||
                  tool.risk === "write" ||
                  tool.risk === "destructive"
                    ? tool.risk
                    : "unknown"
                }`,
              )}
            </Badge>
          </div>
          {tool.description ? (
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              {tool.description}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
            {t("tools.inputFields", {
              fields:
                Object.keys(tool.inputSchema ?? {}).slice(0, 8).join(", ") ||
                t("tools.schemaObject"),
            })}
          </p>
        </article>
      ))}
    </div>
  );
}

export function ExternalTextLink({
  children,
  href,
}: {
  children: React.ReactNode;
  href?: string | null;
}) {
  if (!href) return null;
  return (
    <a
      className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-950 dark:text-white dark:decoration-white/20 dark:hover:decoration-white"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

export function publicMcpDescription(input: {
  item?: MarketItemSummary;
  manifest?: MarketMcpManifest;
}) {
  return (
    input.manifest?.description ||
    input.item?.summary ||
    "Browse an MCP server in the SourceWeft public MCP market."
  );
}

export async function McpFaqSection() {
  const t = await getTranslations("mcp.faq");
  return (
    <section className={`mx-auto pb-16 ${mcpContainerClassName}`}>
      <div className="border-t border-zinc-300 pt-10 dark:border-white/10">
        <div className="mb-7 max-w-2xl">
          <p className="text-xs font-semibold uppercase text-zinc-400">
            {t("eyebrow")}
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">
            {t("heading")}
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {mcpFaqKeys.map((key) => (
            <article
              className="rounded-lg border border-zinc-300 bg-white/54 p-5 dark:border-white/10 dark:bg-white/[0.03]"
              key={key}
            >
              <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
                {t(`items.${key}.question`)}
              </h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {t(`items.${key}.answer`)}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
