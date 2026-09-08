"use client";
import * as React from "react";
import type {
  RegistryVersionDetail,
  RegistryVersionsResponse,
} from "@sourceweft/contracts";
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
  onView: (detail: RegistryVersionDetail) => void;
  onChanged: () => void;
}) {
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
  }, [workspaceId, catalogId, selected, onView]);
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
      setError(e instanceof Error ? e.message : "Version switch failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Skill versions"
      className="space-y-2 rounded-lg border p-4 text-sm"
    >
      <label className="block font-medium" htmlFor="registry-version">
        Version
      </label>
      <select
        id="registry-version"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full rounded border bg-background p-2"
      >
        {!list?.items.some((v) => v.id === selected) ? (
          <option value={selected}>Selected version</option>
        ) : null}
        {list?.items.map((v) => (
          <option key={v.id} value={v.id}>
            {v.version} · {v.status}
            {v.isCurrent ? " · recommended" : ""}
            {list.installed?.skillVersionId === v.id ? " · installed" : ""}
          </option>
        ))}
      </select>
      {list?.nextCursor ? (
        <Button
          variant="outline"
          size="sm"
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
      {list?.installed ? (
        <p>
          Installed:{" "}
          {list.items.find((v) => v.id === list.installed?.skillVersionId)
            ?.version ?? list.installed.skillVersionId}{" "}
          · {list.installed.enabled ? "enabled" : "disabled"}
        </p>
      ) : (
        <p>Not installed in this workspace.</p>
      )}
      {list?.installed && selected !== list.installed.skillVersionId ? (
        <Button
          size="sm"
          disabled={busy || detail?.version.status !== "published"}
          onClick={switchVersion}
        >
          Use selected version
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {detail ? (
        <>
          <p>{detail.version.description}</p>
          {detail.version.sourceUrl ? (
            <a
              className="underline"
              href={detail.version.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Exact source version
            </a>
          ) : null}
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
            <summary>Files ({detail.files.length})</summary>
            {detail.files.map((f) => (
              <p key={f.path} className="break-all text-xs">
                {f.path} · {f.sizeBytes} bytes
              </p>
            ))}
          </details>
        </>
      ) : null}
    </section>
  );
}
