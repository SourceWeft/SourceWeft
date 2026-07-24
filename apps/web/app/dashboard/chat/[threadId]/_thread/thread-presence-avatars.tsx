"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import type { PresenceViewer } from "./use-thread-presence";

const MAX_SHOWN = 4;

function viewerLabel(viewer: PresenceViewer): string {
  const name = viewer.name || "";
  if (viewer.isGuest) {
    return name ? `${name} · Guest` : "Guest";
  }
  return name || "Member";
}

function viewerInitials(viewer: PresenceViewer): string {
  const source = (viewer.name || viewer.userId).trim();
  return source.slice(0, 2).toUpperCase();
}

/**
 * Overlapping avatar stack of who is currently viewing the thread. Renders
 * nothing when it's just you (or nobody) — there is no one to be "present" with.
 * Presence is name/avatar only (no email); the tooltip marks guests.
 */
export function ThreadPresenceAvatars({
  viewers,
}: {
  viewers: PresenceViewer[];
}) {
  if (viewers.length <= 1) {
    return null;
  }

  const shown = viewers.slice(0, MAX_SHOWN);
  const overflow = viewers.length - shown.length;

  return (
    <div className="flex items-center -space-x-2" aria-label="Who's viewing">
      {shown.map((viewer) => (
        <Avatar
          key={viewer.userId}
          className={`size-6 border border-background ${
            viewer.isSelf ? "ring-1 ring-primary" : ""
          }`}
          title={viewerLabel(viewer)}
        >
          {viewer.image ? (
            <AvatarImage alt={viewerLabel(viewer)} src={viewer.image} />
          ) : null}
          <AvatarFallback className="text-[10px]">
            {viewerInitials(viewer)}
          </AvatarFallback>
        </Avatar>
      ))}
      {overflow > 0 ? (
        <div className="flex size-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] text-muted-foreground">
          +{overflow}
        </div>
      ) : null}
    </div>
  );
}
