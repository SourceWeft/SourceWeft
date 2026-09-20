"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { ThreadSourceSelection } from "@sourceweft/contracts";
import { contentClient } from "../../../../../lib/sdk";
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useSourceSelection(
  workspaceId: string | null,
  threadId: string,
) {
  const t = useTranslations("dashboardChat");
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState<number>();
  const generation = useRef(0);
  const queue = useRef<Promise<ThreadSourceSelection> | null>(null);
  const pending = useRef(0);

  useBrowserLayoutEffect(() => {
    const run = ++generation.current;
    pending.current = 0;
    setReady(false);
    setActiveSourceIds([]);
    queue.current = null;
    if (!workspaceId) return;
    if (threadId === "current") {
      setReady(true);
      setRevision(undefined);
      return () => {
        generation.current += 1;
      };
    }
    const boot = contentClient
      .getThreadSourceSelection(workspaceId, threadId)
      .then(({ selection }) => selection);
    queue.current = boot;
    void boot
      .then((selection) => {
        if (generation.current !== run || pending.current) return;
        setRevision(selection.revision);
        setActiveSourceIds(selection.selectedSourceIds);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (generation.current !== run) return;
        toast.error(
          error instanceof Error
            ? error.message
            : t("toasts.sourcesLoadFailed"),
        );
      });
    return () => {
      generation.current += 1;
    };
  }, [workspaceId, threadId]);

  const persistActiveSourceIds = useCallback(
    (ids: string[]) => {
      if (workspaceId && threadId === "current") {
        setActiveSourceIds([...new Set(ids)]);
        return Promise.resolve(true);
      }
      if (!workspaceId || !queue.current) return;
      const run = generation.current;
      const selectedSourceIds = [...new Set(ids)];
      pending.current += 1;
      setReady(false);
      setActiveSourceIds(selectedSourceIds);
      const save = queue.current.then(async (current) => {
        if (generation.current !== run) return current;
        return (
          await contentClient.updateThreadSourceSelection(
            workspaceId,
            threadId,
            {
              selectedSourceIds,
              expectedRevision: current.revision,
            },
          )
        ).selection;
      });
      queue.current = save;
      void save
        .then((selection) => {
          if (generation.current !== run) return;
          pending.current -= 1;
          if (pending.current === 0) {
            setRevision(selection.revision);
            setActiveSourceIds(selection.selectedSourceIds);
            setReady(true);
          }
        })
        .catch((error: unknown) => {
          if (generation.current !== run) return;
          // A rejected chain stays rejected: never retry a stale choice over a newer window.
          setReady(false);
          toast.error(
            error instanceof Error
              ? error.message
              : t("toasts.sourcesSaveFailed"),
          );
        });
      return save.then(
        () => true,
        () => false,
      );
    },
    [workspaceId, threadId, t],
  );

  return {
    activeSourceIds,
    persistActiveSourceIds,
    sourceSelectionReady: ready,
    sourceSelectionRevision: revision,
  };
}
