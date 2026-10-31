"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalNetworkRequest } from "@sourceweft/sdk";
import { localDevicesClient } from "../../../../../lib/sdk";
import { NETWORK_REQUEST_POLL_INTERVAL_MS } from "./network-access-state";

/**
 * Pending network approvals of one local conversation.
 *
 * Polls only while `enabled` (a local conversation with an active run); the
 * list is dropped as soon as polling stops, because an approval can only be
 * pending while its command is running. A failed poll keeps the last list: a
 * blip must not make a card the user is reading vanish.
 */
export function useNetworkRequests(input: {
  workspaceId: string | null | undefined;
  threadId: string | null | undefined;
  enabled: boolean;
}) {
  const { workspaceId, threadId, enabled } = input;
  const [requests, setRequests] = useState<LocalNetworkRequest[]>([]);
  // Ids answered by this user; a poll that raced the answer must not bring the
  // card back.
  const answeredRef = useRef(new Set<string>());

  useEffect(() => {
    answeredRef.current = new Set();
    if (!enabled || !workspaceId || !threadId) {
      setRequests([]);
      return;
    }
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await localDevicesClient.listNetworkRequests(
          workspaceId,
          threadId,
        );
        if (!active) return;
        setRequests(
          response.requests.filter(
            (request) => !answeredRef.current.has(request.id),
          ),
        );
      } catch {
        // Keep the previous list; the next tick retries.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), NETWORK_REQUEST_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, workspaceId, threadId]);

  const remove = useCallback((id: string) => {
    answeredRef.current.add(id);
    setRequests((current) => current.filter((request) => request.id !== id));
  }, []);

  return { requests, remove };
}
