"use client";

import { useCallback, useEffect, useState } from "react";
import type { ResearchRun } from "@sourceweft/contracts/source-research";
import { contentClient } from "../../../../../../lib/sdk";

const POLL_INTERVAL_MS = 3000;

export function isTerminalResearch(run: ResearchRun | null) {
  return (
    run !== null &&
    (run.status === "ready" ||
      run.status === "failed" ||
      run.status === "cancelled")
  );
}

/** Follows one research run, polling every 3 seconds until it reaches a terminal state. */
export function useResearchRun(workspaceId: string, runId: string | null) {
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setRun(null);
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let terminal = false;
      try {
        const result = await contentClient.getResearch(workspaceId, runId);
        if (cancelled) return;
        setRun(result.run);
        setError(null);
        terminal = isTerminalResearch(result.run);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!cancelled && !terminal) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, runId, tick]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    try {
      await contentClient.cancelResearch(workspaceId, runId);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    setTick((value) => value + 1);
  }, [workspaceId, runId]);

  return { run, cancel, error };
}
