"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { contentClient } from "../../../../../lib/sdk";

export type SavedNoteRef = { noteId: string; sourceId: string; title: string };

/**
 * Which of the given answers have already been saved as notes. Asks the server
 * once per new message id, so reloading the page keeps the "saved" state.
 */
export function useSavedNotes(
  workspaceId: string | null | undefined,
  messageIds: string[],
) {
  const [notes, setNotes] = useState<Record<string, SavedNoteRef>>({});
  const asked = useRef<Set<string>>(new Set());
  const key = messageIds.join(",");

  useEffect(() => {
    if (!workspaceId) return;
    const fresh = messageIds.filter((id) => !asked.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => asked.current.add(id));
    let cancelled = false;
    // The endpoint caps one request at 200 ids.
    for (let i = 0; i < fresh.length; i += 200) {
      contentClient
        .listSavedNotes(workspaceId, fresh.slice(i, i + 200))
        .then((result) => {
          if (!cancelled && Object.keys(result.notes).length > 0) {
            setNotes((current) => ({ ...current, ...result.notes }));
          }
        })
        .catch(() => {
          // Not knowing is harmless: the button just shows its default state.
          fresh.slice(i, i + 200).forEach((id) => asked.current.delete(id));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key]);

  const markSaved = useCallback((messageId: string, note: SavedNoteRef) => {
    asked.current.add(messageId);
    setNotes((current) => ({ ...current, [messageId]: note }));
  }, []);

  return { notes, markSaved };
}
