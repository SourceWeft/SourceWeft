"use client";
import * as React from "react";
import type {
  RegistryVersionDetail,
  RegistryVersionsResponse,
} from "@sourceweft/contracts";
import {
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sourceweft/ui-web/components/ui/alert-dialog";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { HttpClientError } from "@sourceweft/sdk";
import { contentClient } from "../../../../lib/sdk";
import { resolveUpdateTarget } from "./skill-version-update";
import { skillsMarketCopy } from "./skills-market-copy";

/** What the API reports when a version can do more than the installed one. */
type VersionEscalation = { addsScripts: boolean; newFlags: string[] };

function readEscalation(details: unknown): VersionEscalation {
  const value = (details ?? {}) as Partial<VersionEscalation>;
  return {
    addsScripts: value.addsScripts === true,
    newFlags: Array.isArray(value.newFlags)
      ? value.newFlags.filter(
          (flag): flag is string => typeof flag === "string",
        )
      : [],
  };
}

/** A scan flag in words; an unknown one is shown as it is rather than hidden. */
function describeScanFlag(flag: string) {
  if (flag === "binary:executable") return "Ships a compiled binary";
  if (flag === "tool:sensitive") return "Asks for sensitive tools";
  if (flag.startsWith("egress:"))
    return `Sends data out or runs remote code (${flag})`;
  if (flag.startsWith("injection:"))
    return `Contains instructions aimed at the model (${flag})`;
  if (flag.startsWith("secret:"))
    return `Contains something that looks like a credential (${flag})`;
  return flag;
}

export function RegistryVersions({
  workspaceId,
  catalogId,
  initialVersionId,
  currentVersionId,
  refreshKey,
  onView,
  onChanged,
}: {
  workspaceId: string;
  catalogId: string;
  initialVersionId: string;
  /**
   * The skill's published current version, when the caller knows it. The list
   * below is paged by age, so the current version is not always in it.
   */
  currentVersionId?: string | null;
  /**
   * Changes when the caller installed or removed the skill itself, so
   * "Installed" and the update notice are re-read instead of going stale.
   */
  refreshKey?: string;
  onView: (detail: RegistryVersionDetail | null) => void;
  onChanged: () => void;
}) {
  const [list, setList] = React.useState<RegistryVersionsResponse | null>(null);
  const [selected, setSelected] = React.useState(initialVersionId);
  const [detail, setDetail] = React.useState<RegistryVersionDetail | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // What is being switched to travels with the escalation, so confirming it
  // retries the same version even if the selection moved meanwhile.
  const [escalation, setEscalation] = React.useState<
    (VersionEscalation & { versionId: string }) | null
  >(null);
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
  }, [workspaceId, catalogId, reload, refreshKey]);
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
    // `refreshKey` too: installing is what gives a workspace a claim to a
    // restricted skill's text, so the documents can change with it.
  }, [workspaceId, catalogId, selected, onView, reload, refreshKey]);
  async function switchVersion(
    versionId: string,
    acknowledgeEscalation = false,
  ) {
    if (!list?.installed) return;
    setBusy(true);
    setError(null);
    try {
      await contentClient.switchRegistryVersion(
        workspaceId,
        list.installed.id,
        versionId,
        acknowledgeEscalation ? { acknowledgeEscalation: true } : undefined,
      );
      setEscalation(null);
      // After an update, show what is installed now rather than the version
      // that happened to be selected.
      setSelected(versionId);
      setReload((v) => v + 1);
      onChanged();
    } catch (e) {
      // A version that adds scripts or new scan flags is not switched to
      // silently: the API names what escalates, and the dialog asks.
      if (
        !acknowledgeEscalation &&
        e instanceof HttpClientError &&
        e.code === "SKILL_VERSION_ESCALATION"
      ) {
        setEscalation({ ...readEscalation(e.details), versionId });
        return;
      }
      setEscalation(null);
      setError(e instanceof Error ? e.message : "Version switch failed");
    } finally {
      setBusy(false);
    }
  }
  const current = detail?.version;
  const statusLabels = {
    draft: "Under review",
    published: "Published",
    deprecated: "Deprecated",
    disabled: "Disabled",
  };
  const shortVersion = (version: string) =>
    /^[a-f0-9]{12,40}$/i.test(version) ? version.slice(0, 8) : version;
  const installedHere = list?.installed?.skillVersionId === selected;
  // An install pins one version; this is the newer one it could move to.
  const updateTargetId = resolveUpdateTarget({
    installedVersionId: list?.installed?.skillVersionId,
    currentVersionId,
    versions: list?.items,
  });
  const updateTargetVersion = list?.items.find(
    (v) => v.id === updateTargetId,
  )?.version;
  // Offered whenever the viewed version is not the installed one — also when it
  // is the update target. The notice above is a shortcut to the same switch,
  // not a replacement for the control people already know.
  const offerSelected = !!list?.installed && !installedHere;
  const issueCount =
    (current?.diagnostics.length ?? 0) + (current?.findings.length ?? 0);

  return (
    <section
      aria-label="Skill versions"
      className="overflow-hidden rounded-lg border border-border bg-muted/15 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Version</span>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger
            aria-label="Version"
            size="sm"
            className="h-7 w-auto min-w-32 gap-2 border-0 bg-transparent px-2 font-mono text-xs shadow-none"
            title={current?.version}
          >
            <SelectValue>
              {shortVersion(
                current?.version ??
                  list?.items.find((v) => v.id === selected)?.version ??
                  "Selected version",
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!list?.items.some((v) => v.id === selected) ? (
              <SelectItem value={selected}>Selected version</SelectItem>
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
                  {v.isCurrent ? " · Recommended" : ""}
                  {list.installed?.skillVersionId === v.id
                    ? " · Installed"
                    : ""}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {busy ? (
          <Loader2
            aria-label="Loading version"
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
              <Badge variant="secondary">Recommended</Badge>
            ) : null}
            {installedHere ? (
              <Badge variant="secondary">
                Installed{list?.installed?.enabled ? "" : " · Off"}
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
            title="View this exact source version"
          >
            Source <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
      {updateTargetId ? (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-primary/5 px-3 py-2"
          data-testid="skill-update-notice"
        >
          <span className="text-foreground">
            {updateTargetVersion
              ? skillsMarketCopy.updates.noticeWithVersion(
                  shortVersion(updateTargetVersion),
                )
              : skillsMarketCopy.updates.notice}
          </span>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => void switchVersion(updateTargetId)}
          >
            {skillsMarketCopy.updates.action}
          </Button>
        </div>
      ) : null}
      {list?.nextCursor || offerSelected ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          {offerSelected ? (
            <>
              <span className="text-muted-foreground">
                Viewing a different version from the one installed.
              </span>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={busy || current?.status !== "published"}
                onClick={() => void switchVersion(selected)}
              >
                Use this version
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
                    e instanceof Error ? e.message : "Could not load versions",
                  );
                }
              }}
            >
              More versions
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
            Retry
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
            Version details
            <span className="ml-auto">
              {detail.files.length} files
              {issueCount ? ` · ${issueCount} review notes` : ""}
            </span>
          </summary>
          <div className="space-y-3 border-t border-border/60 px-3 py-3">
            <p className="break-all text-muted-foreground">
              Source revision{" "}
              <code className="text-foreground">{detail.version.version}</code>
            </p>
            {!detail.version.hasIngestion ? (
              <p className="text-muted-foreground">
                No import diagnostics were recorded for this version.
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
                Review: {f.ruleId} {f.file}
                {f.line ? `:${f.line}` : ""}
              </p>
            ))}
            {detail.version.moderation ? (
              <p>
                Review: {detail.version.moderation.action}
                {detail.version.moderation.reason
                  ? ` — ${detail.version.moderation.reason}`
                  : ""}
              </p>
            ) : null}
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                Files ({detail.files.length})
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
      <AlertDialog
        open={escalation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEscalation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This version can do more</AlertDialogTitle>
            <AlertDialogDescription>
              Compared with the version installed now, it:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {escalation?.addsScripts ? (
              <li>Adds scripts that run in the sandbox</li>
            ) : null}
            {escalation?.newFlags.map((flag) => (
              <li key={flag}>{describeScanFlag(flag)}</li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep the installed version
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                // Stay open until the switch has actually happened.
                event.preventDefault();
                if (escalation) void switchVersion(escalation.versionId, true);
              }}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Switch to it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
