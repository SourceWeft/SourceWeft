"use client";
import * as React from "react";
import type {
  RegistryVersionDetail,
  RegistryVersionsResponse,
} from "@sourceweft/contracts";
import { useTranslations } from "next-intl";
import {
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
} from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { contentClient } from "../../../../lib/sdk";

export function RegistryVersions({
  workspaceId,
  catalogId,
  initialVersionId,
  onView,
  onChanged,
}: {
  workspaceId: string;
  catalogId: string;
  initialVersionId: string;
  onView: (detail: RegistryVersionDetail | null) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("dashboardSkills");
  const [list, setList] = React.useState<RegistryVersionsResponse | null>(null);
  const [selected, setSelected] = React.useState(initialVersionId);
  const [detail, setDetail] = React.useState<RegistryVersionDetail | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    contentClient
      .listRegistryVersions(workspaceId, catalogId)
      .then((result) => {
        if (active) setList(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, catalogId, reload]);
  React.useEffect(() => {
    let active = true;
    setError(null);
    setDetail(null);
    onView(null);
    setBusy(true);
    contentClient
      .getRegistryVersion(workspaceId, catalogId, selected)
      .then((result) => {
        if (active) {
          setDetail(result);
          onView(result);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, catalogId, selected, onView, reload]);
  async function switchVersion() {
    if (!list?.installed) return;
    setBusy(true);
    setError(null);
    try {
      await contentClient.switchRegistryVersion(
        workspaceId,
        list.installed.id,
        selected,
      );
      setReload((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("versions.switchFailed"));
    } finally {
      setBusy(false);
    }
  }
  const current = detail?.version;
  const statusLabels = {
    draft: t("versions.status.draft"),
    published: t("versions.status.published"),
    deprecated: t("versions.status.deprecated"),
    disabled: t("versions.status.disabled"),
  };
  const shortVersion = (version: string) =>
    /^[a-f0-9]{12,40}$/i.test(version) ? version.slice(0, 8) : version;
  const installedHere = list?.installed?.skillVersionId === selected;
  const issueCount =
    (current?.diagnostics.length ?? 0) + (current?.findings.length ?? 0);

  return (
    <section
      aria-label={t("versions.ariaLabel")}
      className="overflow-hidden rounded-lg border border-border bg-muted/15 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{t("versions.versionLabel")}</span>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger
            aria-label={t("versions.versionLabel")}
            size="sm"
            className="h-7 w-auto min-w-32 gap-2 border-0 bg-transparent px-2 font-mono text-xs shadow-none"
            title={current?.version}
          >
            <SelectValue>
              {shortVersion(
                current?.version ??
                  list?.items.find((v) => v.id === selected)?.version ??
                  t("versions.selectedVersion"),
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!list?.items.some((v) => v.id === selected) ? (
              <SelectItem value={selected}>
                {t("versions.selectedVersion")}
              </SelectItem>
            ) : null}
            {list?.items.map((v) => (
              <SelectItem
                key={v.id}
                value={v.id}
                textValue={shortVersion(v.version)}
              >
                <span className="font-mono">{shortVersion(v.version)}</span>
                <span className="text-xs text-muted-foreground">
                  {statusLabels[v.status]}
                  {v.isCurrent ? ` · ${t("versions.recommended")}` : ""}
                  {list.installed?.skillVersionId === v.id
                    ? ` · ${t("versions.installed")}`
                    : ""}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {busy ? (
          <Loader2
            aria-label={t("versions.loadingVersion")}
            className="size-3.5 animate-spin text-muted-foreground"
          />
        ) : null}
        {current ? (
          <>
            <Badge
              variant="outline"
              className={
                current.status === "draft"
                  ? "border-amber-500/25 text-amber-700 dark:text-amber-300"
                  : "text-muted-foreground"
              }
            >
              {statusLabels[current.status]}
            </Badge>
            {current.isCurrent ? (
              <Badge variant="secondary">{t("versions.recommended")}</Badge>
            ) : null}
            {installedHere ? (
              <Badge variant="secondary">
                {t("versions.installed")}
                {list?.installed?.enabled ? "" : ` · ${t("versions.off")}`}
              </Badge>
            ) : null}
          </>
        ) : null}
        {current?.sourceUrl ? (
          <a
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            href={current.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title={t("versions.sourceTitle")}
          >
            {t("actions.source")} <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
      {list?.nextCursor || (list?.installed && !installedHere) ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          {list?.installed && !installedHere ? (
            <>
              <span className="text-muted-foreground">
                {t("versions.viewingDifferent")}
              </span>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={busy || current?.status !== "published"}
                onClick={switchVersion}
              >
                {t("versions.useThisVersion")}
              </Button>
            </>
          ) : null}
          {list?.nextCursor ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={async () => {
                try {
                  const next = await contentClient.listRegistryVersions(
                    workspaceId,
                    catalogId,
                    list.nextCursor!,
                  );
                  setList({ ...next, items: [...list.items, ...next.items] });
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : t("versions.loadFailed"),
                  );
                }
              }}
            >
              {t("versions.moreVersions")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-t px-3 py-2 text-destructive"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReload((value) => value + 1)}
          >
            {t("actions.retry")}
          </Button>
        </div>
      ) : null}
      {detail ? (
        <details
          key={detail.version.id}
          className="group border-t border-border/60"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            {t("versions.detailsSummary")}
            <span className="ml-auto">
              {t("versions.files", { count: detail.files.length })}
              {issueCount
                ? ` · ${t("versions.reviewNotes", { count: issueCount })}`
                : ""}
            </span>
          </summary>
          <div className="space-y-3 border-t border-border/60 px-3 py-3">
            <p className="break-all text-muted-foreground">
              {t("versions.sourceRevision")}{" "}
              <code className="text-foreground">{detail.version.version}</code>
            </p>
            {!detail.version.hasIngestion ? (
              <p className="text-muted-foreground">
                {t("versions.noDiagnostics")}
              </p>
            ) : null}
            {detail.version.diagnostics.map((d, i) => (
              <p key={i}>
                {d.file}
                {d.line ? `:${d.line}` : ""}: {d.message}
              </p>
            ))}
            {detail.version.findings.map((f, i) => (
              <p key={i}>
                {t("versions.reviewLabel")}: {f.ruleId} {f.file}
                {f.line ? `:${f.line}` : ""}
              </p>
            ))}
            {detail.version.moderation ? (
              <p>
                {t("versions.reviewLabel")}: {detail.version.moderation.action}
                {detail.version.moderation.reason
                  ? ` — ${detail.version.moderation.reason}`
                  : ""}
              </p>
            ) : null}
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                {t("versions.filesSummary", { count: detail.files.length })}
              </summary>
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md border px-2">
                {detail.files.map((f) => (
                  <div
                    key={f.path}
                    className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0"
                  >
                    <code className="min-w-0 break-all">{f.path}</code>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {f.sizeBytes.toLocaleString("en-US")} B
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </details>
      ) : null}
    </section>
  );
}
