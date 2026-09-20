"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import type {
  GuestRole,
  PendingGuestInvitation,
  WorkspaceGuest,
} from "@sourceweft/contracts";
import { workspaceClient } from "../../../../lib/sdk";

type GuestRoleKey = "editor" | "viewer";

const GUEST_ROLES: { value: GuestRole; roleKey: GuestRoleKey }[] = [
  { value: "editor", roleKey: "editor" },
  { value: "viewer", roleKey: "viewer" },
];

function guestRoleKeyFor(role: GuestRole): GuestRoleKey | undefined {
  return GUEST_ROLES.find((entry) => entry.value === role)?.roleKey;
}

function guestDisplayName(guest: WorkspaceGuest) {
  return guest.name || guest.email || guest.userId;
}

function guestInitials(guest: WorkspaceGuest) {
  const source = guest.name || guest.email || guest.userId;
  return source.slice(0, 2).toUpperCase();
}

/**
 * Guests of one workspace. A guest is an external collaborator scoped to this
 * single workspace — they are not organization members, do not appear in the
 * Team panel, and can never exceed the "editor" role. Everything here is a
 * separate axis from workspace membership (which draws only from the team).
 */
export function WorkspaceGuestsSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const t = useTranslations("dashboardSettings");
  const guestRoleLabel = React.useCallback(
    (role: GuestRole) => {
      const key = guestRoleKeyFor(role);
      return key ? t(`roles.${key}`) : role;
    },
    [t],
  );
  const [guests, setGuests] = React.useState<WorkspaceGuest[]>([]);
  const [invitations, setInvitations] = React.useState<
    PendingGuestInvitation[]
  >([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = React.useState<string | null>(null);
  const [pendingInvitationId, setPendingInvitationId] = React.useState<
    string | null
  >(null);
  const [removeTarget, setRemoveTarget] = React.useState<WorkspaceGuest | null>(
    null,
  );

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<GuestRole>("viewer");
  const [isInviting, setIsInviting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await workspaceClient.listWorkspaceGuests(workspaceId);
      setGuests(result.guests);
      setInvitations(result.invitations);
    } catch {
      setLoadError(t("guests.loadError"));
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, t]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleInvite() {
    if (!workspaceId) return;
    const email = inviteEmail.trim();
    if (!email) {
      toast.error(t("guests.enterEmail"));
      return;
    }
    setIsInviting(true);
    try {
      await workspaceClient.inviteWorkspaceGuest(workspaceId, {
        email,
        role: inviteRole,
      });
      toast.success(t("guests.invitationSent"));
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("viewer");
      await refresh();
    } catch {
      toast.error(t("guests.inviteError"));
    } finally {
      setIsInviting(false);
    }
  }

  async function handleRemoveGuest(guest: WorkspaceGuest) {
    if (!workspaceId) return;
    setPendingUserId(guest.userId);
    try {
      await workspaceClient.removeWorkspaceGuest(workspaceId, guest.userId);
      setGuests((value) =>
        value.filter((entry) => entry.userId !== guest.userId),
      );
      toast.success(
        t("guests.guestRemoved", { name: guestDisplayName(guest) }),
      );
    } catch {
      toast.error(t("guests.removeGuestError"));
    } finally {
      setPendingUserId(null);
      setRemoveTarget(null);
    }
  }

  async function handleRevoke(invitation: PendingGuestInvitation) {
    if (!workspaceId) return;
    setPendingInvitationId(invitation.id);
    try {
      await workspaceClient.revokeGuestInvitation(workspaceId, invitation.id);
      setInvitations((value) =>
        value.filter((entry) => entry.id !== invitation.id),
      );
      toast.success(t("guests.invitationRevoked"));
    } catch {
      toast.error(t("guests.revokeGuestError"));
    } finally {
      setPendingInvitationId(null);
    }
  }

  const isEmpty = guests.length === 0 && invitations.length === 0;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("guests.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("guests.description")}
          </p>
        </div>
        {canManage ? (
          <Button
            className="shrink-0"
            onClick={() => setInviteOpen(true)}
            size="xs"
            type="button"
          >
            <UserPlus className="size-3.5" />
            {t("guests.inviteGuest")}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("guests.loading")}
        </div>
      ) : loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{loadError}</span>
          <Button
            onClick={() => void refresh()}
            size="xs"
            type="button"
            variant="outline"
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : isEmpty ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {t("guests.emptyGuests")}
          {canManage ? ` ${t("guests.emptyGuestsHint")}` : ""}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border bg-background">
          {guests.map((guest) => {
            const isBusy = pendingUserId === guest.userId;
            return (
              <li
                key={guest.userId}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <Avatar className="size-8">
                  {guest.image ? (
                    <AvatarImage
                      alt={guestDisplayName(guest)}
                      src={guest.image}
                    />
                  ) : null}
                  <AvatarFallback className="text-[11px]">
                    {guestInitials(guest)}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {guestDisplayName(guest)}
                    </span>
                    <Badge
                      className="px-1.5 py-0 text-[10px]"
                      variant="secondary"
                    >
                      {t("guests.guestBadge")}
                    </Badge>
                  </div>
                  {guest.email && guest.email !== guestDisplayName(guest) ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {guest.email}
                    </span>
                  ) : null}
                </div>

                <Badge className="text-[11px]" variant="outline">
                  {guestRoleLabel(guest.role)}
                </Badge>

                {canManage ? (
                  <Button
                    className={cn(
                      "size-8 text-muted-foreground hover:text-destructive",
                      isBusy && "pointer-events-none opacity-50",
                    )}
                    onClick={() => setRemoveTarget(guest)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    {isBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    <span className="sr-only">
                      {t("guests.removeGuestSr")}
                    </span>
                  </Button>
                ) : (
                  <span className="w-8" aria-hidden="true" />
                )}
              </li>
            );
          })}

          {invitations.map((invitation) => {
            const isBusy = pendingInvitationId === invitation.id;
            return (
              <li
                key={invitation.id}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <Avatar className="size-8">
                  <AvatarFallback className="text-[11px]">
                    {invitation.email.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {invitation.email}
                    </span>
                    <Badge
                      className="px-1.5 py-0 text-[10px]"
                      variant="outline"
                    >
                      {t("guests.pendingBadge")}
                    </Badge>
                  </div>
                </div>

                <Badge className="text-[11px]" variant="outline">
                  {guestRoleLabel(invitation.role)}
                </Badge>

                {canManage ? (
                  <Button
                    className={cn(
                      "size-8 text-muted-foreground hover:text-destructive",
                      isBusy && "pointer-events-none opacity-50",
                    )}
                    onClick={() => void handleRevoke(invitation)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    {isBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    <span className="sr-only">
                      {t("guests.revokeInvitationSr")}
                    </span>
                  </Button>
                ) : (
                  <span className="w-8" aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("guests.removeDialogTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("guests.removeDialogBody", {
              name: removeTarget
                ? guestDisplayName(removeTarget)
                : t("guests.thisGuest"),
            })}
          </p>
          <DialogFooter>
            <Button
              onClick={() => setRemoveTarget(null)}
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={pendingUserId === removeTarget?.userId}
              onClick={() =>
                removeTarget && void handleRemoveGuest(removeTarget)
              }
              type="button"
              variant="destructive"
            >
              {t("common.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="gap-3">
          <DialogHeader>
            <DialogTitle>{t("guests.inviteDialogTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("guests.inviteDialogDescription")}
          </p>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">
              {t("guests.emailAddress")}
            </span>
            <Input
              autoFocus
              onChange={(event) => setInviteEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isInviting) {
                  event.preventDefault();
                  void handleInvite();
                }
              }}
              placeholder={t("guests.emailPlaceholder")}
              type="email"
              value={inviteEmail}
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">{t("guests.roleLabel")}</span>
            <Select
              onValueChange={(value) => setInviteRole(value as GuestRole)}
              value={inviteRole}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GUEST_ROLES.map((role) => (
                  <SelectItem key={role.value} value={role.value}>
                    <span className="flex flex-col">
                      <span>{t(`roles.${role.roleKey}`)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {t(`roles.${role.roleKey}Hint`)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              onClick={() => setInviteOpen(false)}
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={isInviting || !inviteEmail.trim()}
              onClick={() => void handleInvite()}
              type="button"
            >
              {isInviting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t("guests.sendInvitation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
