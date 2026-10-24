import { LocaleLink } from "../../_components/locale-link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  BadgeCheck,
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
import { mcpCardText } from "../../../../lib/mcp-ai-overview";
import { mcpAuthMethod } from "../../../../lib/mcp-auth-method";
import { mcpGithubAccount, mcpPublisherDomain } from "../../../../lib/mcp-facts";
import {
  mcpToolsStatus,
  type McpToolsStatus,
} from "../../../../lib/mcp-tools-status";
import { mcpToolsValidationReasonKey } from "../../../../lib/mcp-tools-validation";
import {
  mcpRuntimeKind,
  runtimeLabel,
  transportLabel,
} from "../../../../lib/mcp-labels";
import { mcpTemplateDescription } from "../../../../lib/mcp-template-description";
import { slugify } from "../../../../lib/slug";
import { mcpToolParameters } from "../../../../lib/mcp-tool-parameters";

import { McpIcon } from "./mcp-client";
import { McpShowMore } from "./mcp-show-more";
import { mcpPath } from "./mcp-paths";
import { marketingContainerClassName } from "../../../_landing/components/marketing-container";

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

/**
 * The category a page or card leads with: the first one, unless it is
 * "other", which only says nothing better was found. A highlighted category
 * (the one being browsed) wins when the item has it.
 */
export function mcpPrimaryCategory(
  categories: readonly string[],
  highlight?: string,
) {
  if (highlight && categories.includes(highlight)) return highlight;
  const first = categories[0];
  return first && first !== "other" ? first : undefined;
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

// Kept importable from here; they live in client-safe modules.
export { mcpPath, runtimeLabel, transportLabel };

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

/**
 * A verified owner claimed this server and manages its listing (Issue #367,
 * W7). Synchronous so it renders inside both server and client trees.
 */
export function McpClaimedBadge() {
  const t = useTranslations("mcp.badges");
  return (
    <span title={t("claimedTitle")}>
      <Badge tone="good">
        <BadgeCheck className="size-3.5" />
        {t("claimed")}
      </Badge>
    </span>
  );
}

/** The owner says this server is no longer maintained. */
export function McpDeprecatedBadge() {
  const t = useTranslations("mcp.badges");
  return (
    <span title={t("deprecatedTitle")}>
      <Badge tone="warn">
        <Archive className="size-3.5" />
        {t("deprecated")}
      </Badge>
    </span>
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
  const key = mcpRuntimeKind(item);
  const desktop =
    item.runtime === "desktop" || item.desktopOnly || !item.webExecutable;
  return (
    <Badge>
      {desktop ? (
        <Laptop className="size-3.5" />
      ) : (
        <Globe2 className="size-3.5" />
      )}
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

/**
 * A small mark that the server's publisher (its verified registry namespace)
 * also runs its endpoint. Not the "Official" badge, which is the manual
 * first-party flag.
 */
export function McpOfficialPublisherMark({ domain }: { domain: string }) {
  const t = useTranslations("mcp.card");
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300"
      data-official-publisher={domain}
      title={t("officialPublisherTitle", { domain })}
    >
      <BadgeCheck aria-hidden="true" className="size-3.5" />
      {t("officialPublisher")}
    </span>
  );
}

/**
 * Who published a card's server, beside its name: "Official publisher" only
 * when the registry namespace's domain also runs the endpoint, a neutral
 * "Published by GitHub account X" for an `io.github.*` entry with no domain
 * publisher, otherwise the provider name. A claim changes none of this.
 */
async function McpCardPublisher({ item }: { item: MarketItemSummary }) {
  const t = await getTranslations("mcp.card");
  const account = mcpGithubAccount(item);
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
      {account ? (
        <span
          className="truncate"
          data-github-account={account}
          title={t("githubAccountTitle")}
        >
          {t("githubAccount", { owner: account })}
        </span>
      ) : (
        <span className="truncate">{item.providerName ?? item.identifier}</span>
      )}
      {item.publisher?.endpointMatch ? (
        <McpOfficialPublisherMark domain={item.publisher.domain} />
      ) : null}
    </p>
  );
}

export async function McpMarketCard({
  categoryNames,
  highlightCategory,
  hideVerification,
  item,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  /** Category to show when the item has several, e.g. the one being browsed. */
  highlightCategory?: string;
  /** Leave out the verification badge: a list where every card shares it. */
  hideVerification?: boolean;
  item: MarketItemSummary;
}) {
  const t = await getTranslations("mcp.card");
  const tOverview = await getTranslations("mcp.aiOverview");
  const tTemplate = await getTranslations("mcp.template");
  const tStatus = await getTranslations("mcp.toolsStatus");
  const tValidation = await getTranslations("mcp.toolsValidation");
  const trusted = Boolean(item.official || item.verified);
  const primaryCategory = mcpPrimaryCategory(item.categories, highlightCategory);
  // Without an AI summary, the template sentence (#367 W4) stands in for a
  // registry summary no longer than it. A list item has no endpoint.
  const cardText = mcpCardText(
    item,
    mcpTemplateDescription(
      {
        name: item.name,
        publisherDomain: mcpPublisherDomain(item),
        transport: item.transport,
        authMethod: mcpAuthMethod(null, item.requiresAuth),
        toolCount: item.toolsCount,
      },
      tTemplate,
    ),
  );
  // An empty list says why it is empty, never "0 tools" for an unknown.
  const status = mcpToolsStatus({ item });
  const statusText = mcpToolsStatusText(status, tStatus, tValidation);
  return (
    <LocaleLink
      className="group flex h-full flex-col rounded-xl border border-zinc-300 bg-white/62 p-5 transition-all hover:-translate-y-0.5 hover:border-zinc-950/40 hover:bg-white hover:shadow-[0_18px_70px_rgba(39,39,42,0.1)] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-white/35 dark:hover:bg-white/[0.055]"
      href={mcpPath(item.identifier)}
    >
      <div className="flex items-start gap-3">
        <McpIcon
          iconSource={item.iconSource}
          iconUrl={item.iconUrl}
          name={item.name}
          trusted={trusted}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold leading-6 text-zinc-950 dark:text-white">
            {item.name}
          </h3>
          <McpCardPublisher item={item} />
        </div>
        {hideVerification ? null : <McpVerificationBadge item={item} />}
      </div>

      <p
        className="mt-4 line-clamp-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400"
        {...(cardText.ai
          ? {
              "data-ai-summary": "",
              title: tOverview("cardSummaryTitle"),
            }
          : {})}
      >
        {cardText.text}
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
        {item.claimed ? <McpClaimedBadge /> : null}
        {item.deprecated ? <McpDeprecatedBadge /> : null}
      </div>

      <div className="mt-auto flex items-center gap-x-4 gap-y-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-white/10">
        {primaryCategory ? (
          <span className="min-w-0 truncate">
            {mcpCategoryLabel(primaryCategory, categoryNames)}
          </span>
        ) : null}
        {status.kind === "listed" ? (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <Code2 className="size-3.5" />
            {t("tools", { count: status.count })}
          </span>
        ) : (
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            data-tools-status={status.kind}
            data-tools-validation={
              status.kind === "failed" ? status.reason : undefined
            }
            title={statusText.explain}
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="truncate">{statusText.label}</span>
          </span>
        )}
        <span className="ml-auto shrink-0">{formatDate(item.updatedAt)}</span>
      </div>
    </LocaleLink>
  );
}

export function McpCardGrid({
  categoryNames,
  className,
  highlightCategory,
  hideVerification,
  initialCount,
  items,
  showMoreLabel,
}: {
  categoryNames?: ReadonlyMap<string, string>;
  className?: string;
  highlightCategory?: string;
  hideVerification?: boolean;
  /** Show this many cards, the rest behind a "Show more" control. */
  initialCount?: number;
  items: MarketItemSummary[];
  showMoreLabel?: string;
}) {
  const gridClassName = cn(
    "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3",
    className,
  );
  const cards = items.map((item) => (
    <McpMarketCard
      categoryNames={categoryNames}
      highlightCategory={highlightCategory}
      hideVerification={hideVerification}
      item={item}
      key={item.identifier}
    />
  ));
  if (initialCount !== undefined && showMoreLabel) {
    return (
      <McpShowMore
        className={gridClassName}
        initial={initialCount}
        label={showMoreLabel}
      >
        {cards}
      </McpShowMore>
    );
  }
  return <div className={gridClassName}>{cards}</div>;
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
        <LocaleLink
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
          href={viewAllHref}
        >
          {t("viewAll")}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </LocaleLink>
      </div>
      <McpCardGrid
        categoryNames={categoryNames}
        highlightCategory={highlightCategory}
        items={items}
      />
    </section>
  );
}

/**
 * The label and the one-sentence explanation of a tool status. `failed` keeps
 * the stdio validation's own wording and reasons; the others say what is
 * actually known: not "0 tools", and never that signing in reveals tools.
 */
export function mcpToolsStatusText(
  status: McpToolsStatus,
  tStatus: (key: string, values?: Record<string, string | number>) => string,
  tValidation: (key: string, values?: Record<string, string | number>) => string,
) {
  switch (status.kind) {
    case "listed":
      return { label: String(status.count), explain: "" };
    case "partial":
      return {
        label: tStatus("label.partial", { count: status.count }),
        explain: tStatus("explain.partial", { count: status.count }),
      };
    case "failed":
      return {
        label: tValidation("withReason", {
          reason: tValidation(
            `reason.${mcpToolsValidationReasonKey(status.reason)}`,
          ),
        }),
        explain: tStatus("explain.failed", {
          reason: tValidation(
            `reason.${mcpToolsValidationReasonKey(status.reason)}`,
          ),
        }),
      };
    default:
      return {
        label: tStatus(`label.${status.kind}`),
        explain: tStatus(`explain.${status.kind}`),
      };
  }
}

export async function McpToolRows({
  tools,
  status,
}: {
  tools: MarketMcpToolManifest[];
  /** Why the list is empty, when it is. */
  status?: McpToolsStatus;
}) {
  const t = await getTranslations("mcp");
  if (tools.length === 0) {
    const tStatus = await getTranslations("mcp.toolsStatus");
    const tValidation = await getTranslations("mcp.toolsValidation");
    const text = mcpToolsStatusText(
      status ?? { kind: "unindexed" },
      tStatus,
      tValidation,
    );
    return (
      <div
        className="rounded-lg border border-zinc-300 bg-white/52 p-5 text-sm text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400"
        data-tools-status={status?.kind ?? "unindexed"}
        data-tools-validation={
          status?.kind === "failed" ? status.reason : undefined
        }
      >
        {text.explain}
      </div>
    );
  }

  return (
    <div className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-300 bg-white/58 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {tools.map((tool) => (
        <article
          className="scroll-mt-24 p-4"
          id={`tool-${slugifyAnchor(tool.name)}`}
          key={tool.name}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">
                {tool.name}
              </h3>
              {toolTitle(tool) ? (
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {toolTitle(tool)}
                </p>
              ) : null}
            </div>
            {/* Listed tools carry no risk of their own: an "Unknown" badge on
                every one of them would say nothing. */}
            {tool.risk === "read" ||
            tool.risk === "write" ||
            tool.risk === "destructive" ? (
              <Badge tone={tool.risk === "read" ? "good" : "warn"}>
                {t(`badges.risk.${tool.risk}`)}
              </Badge>
            ) : null}
          </div>
          {tool.description ? (
            <p className="mt-3 whitespace-pre-line break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              {tool.description}
            </p>
          ) : null}
          <McpToolParameterList inputSchema={tool.inputSchema} />
        </article>
      ))}
    </div>
  );
}

function toolTitle(tool: MarketMcpToolManifest) {
  const annotated = tool.annotations?.title;
  const title =
    tool.title ?? (typeof annotated === "string" ? annotated : undefined);
  return title && title !== tool.name ? title : null;
}

const SHOWN_TOOL_PARAMETERS = 12;

async function McpToolParameterList({
  inputSchema,
}: {
  inputSchema: Record<string, unknown> | undefined;
}) {
  const t = await getTranslations("mcp");
  const parameters = mcpToolParameters(inputSchema);
  if (parameters.length === 0) {
    return (
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
        {t("tools.noParameters")}
      </p>
    );
  }
  const hidden = parameters.length - SHOWN_TOOL_PARAMETERS;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-500">
      <span>{t("tools.parameters")}</span>
      {parameters.slice(0, SHOWN_TOOL_PARAMETERS).map((parameter) => (
        <code
          className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-zinc-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300"
          key={parameter.name}
        >
          {parameter.name}
          {parameter.required ? (
            <span className="ml-1 font-sans text-zinc-500">
              {t("tools.required")}
            </span>
          ) : null}
        </code>
      ))}
      {hidden > 0 ? (
        <span>{t("tools.moreParameters", { count: hidden })}</span>
      ) : null}
    </div>
  );
}

/** Only http(s) links are ever rendered; anything else is not a link. */
export function safeExternalHref(href: string | null | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function ExternalTextLink({
  children,
  href: rawHref,
}: {
  children: React.ReactNode;
  href?: string | null;
}) {
  const href = safeExternalHref(rawHref);
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
    <section className={`mx-auto pb-16 ${marketingContainerClassName}`}>
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
