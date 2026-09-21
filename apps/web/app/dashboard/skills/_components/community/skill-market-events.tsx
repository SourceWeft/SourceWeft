"use client";

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { SkillMarketEvent } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import {
  errorMessage,
  errorStatus,
  listSkillEvents,
  reinferSkillCategories,
} from "../../../../../lib/skill-market-audit";
import { skillMarketAdminCopy } from "../../../admin/market/_components/skill-market-admin-copy";
import { SkillMarketEventList } from "../../../admin/market/_components/skill-market-event-list";

const copy = skillMarketAdminCopy.events;

/**
 * A community skill's market history, for market admins: every decision
 * about it and its repository, newest first — including which version
 * cleared its verified badge — and a button to re-infer its categories.
 * Renders nothing for anyone else (the route answers them 403) or while it
 * loads.
 */
export function SkillMarketEvents({
  skillId,
  onChanged,
}: {
  skillId: string;
  /** After the categories changed, so the page can re-read the standing. */
  onChanged?: () => void;
}) {
  const [events, setEvents] = React.useState<SkillMarketEvent[] | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await listSkillEvents(skillId, 50);
      setEvents(result.items);
      setError(null);
    } catch (caught) {
      const status = errorStatus(caught);
      // Not a market admin, signed out, or not a community skill.
      if (status === 401 || status === 403 || status === 404) {
        setHidden(true);
      } else {
        setError(errorMessage(caught, copy.failed));
        setEvents([]);
      }
    }
  }, [skillId]);

  React.useEffect(() => {
    setEvents(null);
    setHidden(false);
    void load();
  }, [load]);

  if (hidden || events === null) return null;

  async function reinfer() {
    setBusy(true);
    setNotice(null);
    try {
      const standing = await reinferSkillCategories(skillId);
      setNotice(copy.reinferDone(standing.categorySlugs));
      onChanged?.();
      await load();
    } catch (caught) {
      setNotice(errorMessage(caught, copy.reinferFailed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={copy.skillTitle}
      className="rounded-2xl border border-border bg-background p-4 shadow-xs"
      data-testid="skill-market-events"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {copy.skillTitle}
        </h2>
        <Button
          disabled={busy}
          onClick={() => void reinfer()}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {copy.reinfer}
        </Button>
      </div>
      {notice ? (
        <p className="mt-2 text-xs" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {events.length === 0 && !error ? (
        <p className="mt-2 text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <div className="mt-2">
          <SkillMarketEventList events={events} />
        </div>
      )}
    </section>
  );
}
