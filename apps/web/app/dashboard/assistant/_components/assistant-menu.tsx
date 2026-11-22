"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { MoreHorizontal } from "lucide-react";
import type { WorkspaceMember } from "@sourceweft/contracts";
import type { Assistant } from "@sourceweft/contracts/assistants";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Label } from "@sourceweft/ui-web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { useAssistantMutations } from "../../../../lib/assistant";
import { useAssistantAction } from "./use-assistant-actions";

/**
 * The assistant's own actions: pause or resume (any member who can write),
 * change the steward (admins only), and the Router's work log, which opens
 * its conversation read-only.
 */
export function AssistantMenu({
  assistant,
  workspaceId,
  isAdmin,
  canWrite,
  members,
}: {
  assistant: Assistant;
  workspaceId: string | null;
  isAdmin: boolean;
  canWrite: boolean;
  members: readonly WorkspaceMember[];
}) {
  const t = useTranslations("dashboardAssistant");
  const { update } = useAssistantMutations(workspaceId);
  const { run } = useAssistantAction();
  const [choosing, setChoosing] = React.useState(false);
  const paused = assistant.status === "paused";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("menu.open")}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canWrite ? (
            <DropdownMenuItem
              disabled={update.isPending}
              onSelect={() =>
                void run(
                  () =>
                    update.mutateAsync({
                      version: assistant.version,
                      action: paused ? "resume" : "pause",
                    }),
                  paused ? t("toasts.resumed") : t("toasts.paused"),
                )
              }
            >
              {paused ? t("menu.resume") : t("menu.pause")}
            </DropdownMenuItem>
          ) : null}
          {isAdmin ? (
            <DropdownMenuItem onSelect={() => setChoosing(true)}>
              {t("menu.changeSteward")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem asChild>
            <Link
              href={`/dashboard/chat/${encodeURIComponent(assistant.routerThreadId)}`}
            >
              {t("menu.viewWorkLog")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {isAdmin ? (
        <StewardDialog
          open={choosing}
          onOpenChange={setChoosing}
          assistant={assistant}
          members={members}
          onSave={(stewardUserId) =>
            run(
              () =>
                update.mutateAsync({
                  version: assistant.version,
                  stewardUserId,
                }),
              t("toasts.stewardChanged"),
            )
          }
          saving={update.isPending}
        />
      ) : null}
    </>
  );
}

function StewardDialog({
  open,
  onOpenChange,
  assistant,
  members,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assistant: Assistant;
  members: readonly WorkspaceMember[];
  onSave: (stewardUserId: string) => Promise<boolean>;
  saving: boolean;
}) {
  const t = useTranslations("dashboardAssistant");
  const [choice, setChoice] = React.useState(assistant.stewardUserId);

  React.useEffect(() => {
    if (open) setChoice(assistant.stewardUserId);
  }, [open, assistant.stewardUserId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("steward.title")}</DialogTitle>
          <DialogDescription>{t("steward.body")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="assistant-steward">{t("steward.label")}</Label>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger id="assistant-steward" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name || member.email || member.userId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("steward.cancel")}
          </Button>
          <Button
            disabled={saving || choice === assistant.stewardUserId}
            onClick={async () => {
              if (await onSave(choice)) onOpenChange(false);
            }}
          >
            {t("steward.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
