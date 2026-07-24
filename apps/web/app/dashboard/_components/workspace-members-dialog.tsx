"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { WorkspaceMembersPanel } from "./dashboard-settings-center/workspace-members-panel";

/**
 * Standalone workspace member management, opened from the sidebar's share
 * button. Membership is a per-workspace concern, not an account setting, so it
 * gets its own surface instead of a settings-center tab; the panel inside
 * carries its own workspace picker.
 */
export function WorkspaceMembersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Workspace members</DialogTitle>
        </DialogHeader>
        <WorkspaceMembersPanel />
      </DialogContent>
    </Dialog>
  );
}
