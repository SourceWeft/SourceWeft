import { useTranslations } from "next-intl";
import type {
  ListMarketMcpToolRevisionsResponse,
  MarketMcpToolRevision,
} from "@sourceweft/market-contracts";
import { formatDate } from "./mcp-display";

/**
 * The change log of the tool list a public MCP page shows (Issue #367, tool
 * revisions): newest first, the latest marked "Current", each entry with its
 * date, the source of the list and how many tools were added, removed and
 * changed, expandable to the tool names. A revision is a change to this
 * listing's list, not a version of the server. Tool names are the server's
 * own text: rendered as plain text, never as markup. Holds no member data.
 */

function ToolNames({
  heading,
  names,
}: {
  heading: string;
  names: readonly string[];
}) {
  if (names.length === 0) return null;
  return (
    <div className="mt-2 text-sm">
      <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
        {heading}
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li
            className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-white/10"
            key={name}
          >
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RevisionEntry({ revision }: { revision: MarketMcpToolRevision }) {
  const t = useTranslations("mcp.toolChangeLog");
  const added = revision.added.length;
  const removed = revision.removed.length;
  const changed = revision.changed.length;
  const hasNames = added + removed + changed > 0;
  const summary = (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-medium tabular-nums">
        {formatDate(revision.observedAt)}
      </span>
      <span className="text-zinc-600 dark:text-zinc-300">
        {t(`sources.${revision.source}`)}
      </span>
      {revision.current ? (
        <span className="rounded-full bg-zinc-950 px-2 py-0.5 text-[11px] text-white dark:bg-white dark:text-zinc-950">
          {t("current")}
        </span>
      ) : null}
      {revision.withdrawn ? (
        <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] dark:border-white/10">
          {t("withdrawn")}
        </span>
      ) : !hasNames ? (
        // A list that is empty after a withdrawal has no tool to count.
        <span className="text-zinc-600 dark:text-zinc-300">{t("emptyList")}</span>
      ) : (
        <>
          <span
            aria-label={t("addedLabel", { count: added })}
            className="font-mono text-emerald-700 tabular-nums dark:text-emerald-300"
          >
            +{added}
          </span>
          <span
            aria-label={t("removedLabel", { count: removed })}
            className="font-mono text-rose-700 tabular-nums dark:text-rose-300"
          >
            −{removed}
          </span>
          <span
            aria-label={t("changedLabel", { count: changed })}
            className="font-mono text-amber-700 tabular-nums dark:text-amber-300"
          >
            ~{changed}
          </span>
        </>
      )}
    </span>
  );
  const body = (
    <>
      <ToolNames heading={t("addedHeading")} names={revision.added} />
      <ToolNames heading={t("removedHeading")} names={revision.removed} />
      {changed > 0 ? (
        <div className="mt-2 text-sm">
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            {t("changedHeading")}
          </p>
          <ul className="mt-1 space-y-1">
            {revision.changed.map((entry) => (
              <li key={entry.name}>
                <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-white/10">
                  {entry.name}
                </span>{" "}
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {entry.fields.map((field) => t(`fields.${field}`)).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {revision.serverVersion ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {t("serverVersion", { version: revision.serverVersion })}
        </p>
      ) : null}
    </>
  );
  return (
    <li
      className="px-5 py-3"
      data-revision={revision.revision}
      data-revision-current={revision.current}
    >
      {hasNames || revision.serverVersion ? (
        <details>
          <summary className="cursor-pointer">{summary}</summary>
          {body}
        </details>
      ) : (
        summary
      )}
    </li>
  );
}

export function McpToolChangeLog({
  history,
}: {
  history: ListMarketMcpToolRevisionsResponse;
}) {
  const t = useTranslations("mcp.toolChangeLog");
  if (history.items.length === 0) return null;
  return (
    <div className="mt-6" data-testid="mcp-tool-change-log">
      <h3 className="text-sm font-semibold">{t("heading")}</h3>
      <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {t("intro")}
      </p>
      <ol className="mt-3 divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-300 bg-white/58 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
        {history.items.map((revision) => (
          <RevisionEntry key={revision.revision} revision={revision} />
        ))}
      </ol>
      {history.nextBefore !== null ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {t("truncated", { count: history.items.length })}
        </p>
      ) : null}
    </div>
  );
}
