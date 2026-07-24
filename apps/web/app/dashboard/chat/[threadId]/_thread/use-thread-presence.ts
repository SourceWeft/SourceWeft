"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contentClient } from "../../../../../lib/sdk";

const TYPING_THROTTLE_MS = 2000;
const TYPING_LOCAL_TTL_MS = 4000;

export type PresenceViewer = {
  userId: string;
  name: string | null;
  image: string | null;
  isGuest: boolean;
  isSelf: boolean;
};

function fallbackViewer(userId: string, currentUserId: string | null): PresenceViewer {
  return {
    userId,
    name: null,
    image: null,
    isGuest: false,
    isSelf: userId === currentUserId,
  };
}

/**
 * Owns presence/typing UI state. It opens NO stream — the single `/room` SSE
 * (in useThreadRoom) feeds it via `onPresence`/`onTyping`. It resolves userIds
 * to display identities over a thread-scoped, canViewThread-gated endpoint (so
 * guests resolve too), and throttles this member's own typing pings.
 */
export function useThreadPresence({
  workspaceId,
  threadId,
  currentUserId,
}: {
  workspaceId: string | null | undefined;
  threadId: string;
  currentUserId: string | null;
}) {
  const [viewerIds, setViewerIds] = useState<string[]>([]);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const [identities, setIdentities] = useState<Map<string, PresenceViewer>>(
    new Map(),
  );

  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const lastTypingSentRef = useRef(0);
  const requestedIdsRef = useRef<Set<string>>(new Set());

  const onPresence = useCallback((here: string[]) => {
    setViewerIds(here);
  }, []);

  const onTyping = useCallback(
    (userId: string) => {
      if (userId === currentUserId) {
        return;
      }
      setTypingUserIds((current) =>
        current.includes(userId) ? current : [...current, userId],
      );
      const timers = typingTimersRef.current;
      const existing = timers.get(userId);
      if (existing) {
        clearTimeout(existing);
      }
      timers.set(
        userId,
        setTimeout(() => {
          timers.delete(userId);
          setTypingUserIds((current) => current.filter((id) => id !== userId));
        }, TYPING_LOCAL_TTL_MS),
      );
    },
    [currentUserId],
  );

  const notifyTyping = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) {
      return;
    }
    lastTypingSentRef.current = now;
    void contentClient
      .sendThreadTyping(workspaceId, threadId, true)
      .catch(() => undefined);
  }, [workspaceId, threadId]);

  // Resolve identities for any viewer/typing id we don't have yet.
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    const needed = [...new Set([...viewerIds, ...typingUserIds])].filter(
      (id) => !identities.has(id) && !requestedIdsRef.current.has(id),
    );
    if (needed.length === 0) {
      return;
    }
    needed.forEach((id) => requestedIdsRef.current.add(id));
    // Apply results unconditionally (no cancelled guard): identity updates are
    // idempotent, and a late resolve for an id no longer in the roster is inert
    // (the memoized viewer lists only map current ids). Suppressing on any dep
    // change would strand an id in requestedIdsRef and never re-request it.
    void contentClient
      .resolveThreadPresenceIdentities(workspaceId, threadId, needed)
      .then((result) => {
        const returned = new Set(result.identities.map((i) => i.userId));
        // Release ids the server didn't return (e.g. briefly out of the live
        // roster during the round-trip) so they can be re-requested.
        needed.forEach((id) => {
          if (!returned.has(id)) {
            requestedIdsRef.current.delete(id);
          }
        });
        setIdentities((current) => {
          const next = new Map(current);
          for (const identity of result.identities) {
            next.set(identity.userId, {
              ...identity,
              isSelf: identity.userId === currentUserId,
            });
          }
          return next;
        });
      })
      .catch(() => {
        // Allow a later retry for these ids.
        needed.forEach((id) => requestedIdsRef.current.delete(id));
      });
  }, [workspaceId, threadId, viewerIds, typingUserIds, identities, currentUserId]);

  // Reset everything when the thread/workspace changes.
  useEffect(() => {
    // Copy the stable refs so the cleanup doesn't read a possibly-changed
    // `.current` (both hold the same object across renders — only mutated).
    const timers = typingTimersRef.current;
    const requested = requestedIdsRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      requested.clear();
      lastTypingSentRef.current = 0;
      setViewerIds([]);
      setTypingUserIds([]);
      setIdentities(new Map());
    };
  }, [workspaceId, threadId]);

  const presentViewers = useMemo(
    () =>
      viewerIds.map(
        (id) => identities.get(id) ?? fallbackViewer(id, currentUserId),
      ),
    [viewerIds, identities, currentUserId],
  );

  const typingViewers = useMemo(
    () =>
      typingUserIds.map(
        (id) => identities.get(id) ?? fallbackViewer(id, currentUserId),
      ),
    [typingUserIds, identities, currentUserId],
  );

  return {
    presentViewers,
    typingViewers,
    onPresence,
    onTyping,
    notifyTyping,
  };
}
