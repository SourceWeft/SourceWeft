"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@sourceweft/ui-web/components/ui/avatar";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@sourceweft/ui-web/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import type { WorkspaceMember, WorkspaceRole } from "@sourceweft/contracts";
import { authClient } from "../../../../lib/auth-client";
import { workspaceClient } from "../../../../lib/sdk";
import { useDashboardChatState } from "../dashboard-chat-state";
import { WorkspaceGuestsSection } from "./workspace-guests-section";

type RoleKey = "admin" | "editor" | "viewer";

const ASSIGNABLE_ROLES: {
  value: WorkspaceRole;
  roleKey: RoleKey;
}[] = [
  { value: "workspace_admin", roleKey: "admin" },
  { value: "editor", roleKey: "editor" },
  { value: "viewer", roleKey: "viewer" },
];

function roleKeyFor(role: WorkspaceRole): RoleKey | undefined {
  return ASSIGNABLE_ROLES.find((entry) => entry.value === role)?.roleKey;
}

function initialsFor(member: WorkspaceMember) {
  const source = member.name || member.email || member.userId;
  return source.slice(0, 2).toUpperCase();
}

function displayName(member: WorkspaceMember) {
  return member.name || member.email || member.userId;
}

/**
 * Members of one workspace, and the controls to manage them. The workspace is
 * the content plane: this panel governs who can read and write inside it, which
 * is a separate axis from organization membership (that lives in the Team
 * panel). Organization owners/admins appear here as derived admins even when no
 * explicit row names them, so the list matches what the server actually
 * enforces.
 */
type OrganizationMember = {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
  organizationRole: string;
};

/**
 * Reads the active organization's roster from better-auth. A workspace member
 * must already belong to the team, so this is the pool the "add member" picker
 * chooses from — you pick a teammate by name or email, never type an id.
 */
function useOrganizationMembers(): OrganizationMember[] {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const roster = (
    activeOrg as
      | {
          members?: Array<{
            userId?: string;
            role?: string;
            user?: {
              id?: string;
              name?: string | null;
              email?: string | null;
              image?: string | null;
            };
          }>;
        }
      | null
      | undefined
  )?.members;

  return React.useMemo(() => {
    if (!roster) return [];
    return roster.flatMap((member) => {
      const userId = member.userId ?? member.user?.id;
      if (!userId) return [];
      return [
        {
          userId,
          name: member.user?.name ?? null,
          email: member.user?.email ?? null,
          image: member.user?.image ?? null,
          organizationRole: member.role ?? "member",
        },
      ];
    });
  }, [roster]);
}

export function WorkspaceMembersPanel() {
  const t = useTranslations("dashboardSettings");
  const roleLabel = React.useCallback(
    (role: WorkspaceRole) => {
      const key = roleKeyFor(role);
      return key ? t(`roles.${key}`) : role;
    },
    [t],
  );
  const { workspaceId, organizationId, workspaces } = useDashboardChatState();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id ?? null;
  const organizationMembers = useOrganizationMembers();

  // Membership is per-workspace, so this panel manages exactly one workspace at
  // a time: the picker below chooses which, defaulting to the one open in the
  // dashboard.
  const [managedWorkspaceId, setManagedWorkspaceId] = React.useState<
    string | null
  >(workspaceId);
  React.useEffect(() => {
    setManagedWorkspaceId(workspaceId);
  }, [workspaceId]);
  const managedWorkspaceName =
    workspaces.find((entry) => entry.id === managedWorkspaceId)?.name ?? null;

  const [members, setMembers] = React.useState<WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = React.useState<string | null>(null);
  const [removeTarget, setRemoveTarget] =
    React.useState<WorkspaceMember | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addRole, setAddRole] = React.useState<WorkspaceRole>("editor");
  const [addingUserId, setAddingUserId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!managedWorkspaceId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const result =
        await workspaceClient.listWorkspaceMembers(managedWorkspaceId);
      setMembers(result.items);
    } catch {
      setLoadError(t("members.loadError"));
    } finally {
      setIsLoading(false);
    }
  }, [managedWorkspaceId, t]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentMember = members.find(
    (member) => member.userId === currentUserId,
  );
  const canManage = currentMember?.role === "workspace_admin";
  const explicitAdminCount = members.filter(
    (member) => member.role === "workspace_admin",
  ).length;

  // Teammates who are not already in this workspace — the only people it makes
  // sense to add. In the shared default workspace this is usually empty, since
  // every team member is already a member by derivation.
  const memberIds = new Set(members.map((member) => member.userId));
  const addableMembers = organizationMembers.filter(
    (member) => !memberIds.has(member.userId),
  );

  async function handleRoleChange(
    member: WorkspaceMember,
    role: WorkspaceRole,
  ) {
    if (!managedWorkspaceId || role === member.role) return;
    setPendingUserId(member.userId);
    try {
      await workspaceClient.updateWorkspaceMemberRole(
        managedWorkspaceId,
        member.userId,
        { role },
      );
      setMembers((value) =>
        value.map((entry) =>
          entry.userId === member.userId
            ? { ...entry, role, source: "explicit" }
            : entry,
        ),
      );
      toast.success(
        t("members.roleChanged", {
          name: displayName(member),
          role: roleLabel(role),
        }),
      );
    } catch {
      toast.error(t("members.roleChangeError"));
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleRemove(member: WorkspaceMember) {
    if (!managedWorkspaceId) return;
    setPendingUserId(member.userId);
    try {
      await workspaceClient.removeWorkspaceMember(
        managedWorkspaceId,
        member.userId,
      );
      setMembers((value) =>
        value.filter((entry) => entry.userId !== member.userId),
      );
      toast.success(
        t("members.memberRemovedWorkspace", { name: displayName(member) }),
      );
    } catch {
      toast.error(t("members.removeError"));
    } finally {
      setPendingUserId(null);
      setRemoveTarget(null);
    }
  }

  async function handleAdd(candidate: OrganizationMember) {
    if (!managedWorkspaceId) return;
    setAddingUserId(candidate.userId);
    try {
      await workspaceClient.addWorkspaceMember(managedWorkspaceId, {
        userId: candidate.userId,
        role: addRole,
      });
      toast.success(
        t("members.memberAdded", {
          name:
            candidate.name || candidate.email || t("common.memberFallback"),
          role: roleLabel(addRole),
        }),
      );
      setAddOpen(false);
      setAddRole("editor");
      await refresh();
    } catch {
      toast.error(t("members.addError"));
    } finally {
      setAddingUserId(null);
    }
  }

  if (!managedWorkspaceId || !organizationId) {
    return (
      <p className="px-1 py-6 text-sm text-muted-foreground">
        {t("members.selectWorkspacePrompt")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("members.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("members.description")}
          </p>
        </div>
        {canManage ? (
          <Button
            className="shrink-0"
            onClick={() => setAddOpen(true)}
            size="xs"
            type="button"
          >
            <UserPlus className="size-3.5" />
            {t("members.addMember")}
          </Button>
        ) : null}
      </div>

      {/* Membership is per-workspace: pick which workspace this panel manages. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t("members.workspaceLabel")}
        </span>
        <Select
          value={managedWorkspaceId}
          onValueChange={(value) => setManagedWorkspaceId(value)}
        >
          <SelectTrigger className="h-8 w-60 text-xs">
            <SelectValue placeholder={t("members.selectWorkspacePlaceholder")}>
              {managedWorkspaceName ??
                t("members.selectWorkspacePlaceholder")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("members.loading")}
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
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            const isBusy = pendingUserId === member.userId;
            // The last explicit admin cannot be demoted or removed, mirroring
            // the server, so the workspace never loses its administrator.
            const isLastAdmin =
              member.role === "workspace_admin" &&
              member.source === "explicit" &&
              explicitAdminCount <= 1;

            return (
              <li
                key={member.userId}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <Avatar className="size-8">
                  {member.image ? (
                    <AvatarImage alt={displayName(member)} src={member.image} />
                  ) : null}
                  <AvatarFallback className="text-[11px]">
                    {initialsFor(member)}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {displayName(member)}
                    </span>
                    {isSelf ? (
                      <span className="text-[10px] text-muted-foreground">
                        {t("members.you")}
                      </span>
                    ) : null}
                    {member.source === "derived" ? (
                      <Badge
                        className="gap-1 px-1.5 py-0 text-[10px]"
                        variant="secondary"
                      >
                        <ShieldCheck className="size-2.5" />
                        {t("members.teamRoleBadge", {
                          role: member.organizationRole || "member",
                        })}
                      </Badge>
                    ) : null}
                  </div>
                  {member.email && member.email !== displayName(member) ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {member.email}
                    </span>
                  ) : null}
                </div>

                {canManage && !isLastAdmin ? (
                  <Select
                    disabled={isBusy}
                    onValueChange={(value) =>
                      void handleRoleChange(member, value as WorkspaceRole)
                    }
                    value={member.role}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((role) => (
                        <SelectItem
                          key={role.value}
                          value={role.value}
                          className="text-xs"
                        >
                          {t(`roles.${role.roleKey}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge className="text-[11px]" variant="outline">
                    {roleLabel(member.role)}
                  </Badge>
                )}

                {canManage &&
                !isSelf &&
                !isLastAdmin &&
                member.source === "explicit" ? (
                  <Button
                    className={cn(
                      "size-8 text-muted-foreground hover:text-destructive",
                      isBusy && "pointer-events-none opacity-50",
                    )}
                    onClick={() => setRemoveTarget(member)}
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
                      {t("members.removeMemberSr")}
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

      <WorkspaceGuestsSection
        canManage={canManage}
        workspaceId={managedWorkspaceId}
      />

      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("members.removeDialogTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("members.removeDialogBody", {
              name: removeTarget
                ? displayName(removeTarget)
                : t("members.thisMember"),
            })}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button
              disabled={pendingUserId === removeTarget?.userId}
              onClick={() => removeTarget && void handleRemove(removeTarget)}
              type="button"
              variant="destructive"
            >
              {t("common.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="gap-3">
          <DialogHeader>
            <DialogTitle>{t("members.addDialogTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("members.addDialogDescription")}
          </p>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">
              {t("members.roleForNewMembers")}
            </span>
            <Select
              onValueChange={(value) => setAddRole(value as WorkspaceRole)}
              value={addRole}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((role) => (
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

          <Command className="rounded-lg border">
            <CommandInput placeholder={t("members.searchPlaceholder")} />
            <CommandList>
              <CommandEmpty>
                {organizationMembers.length === 0
                  ? t("members.noTeammates")
                  : t("members.everyoneAdded")}
              </CommandEmpty>
              <CommandGroup>
                {addableMembers.map((candidate) => {
                  const label =
                    candidate.name || candidate.email || candidate.userId;
                  return (
                    <CommandItem
                      key={candidate.userId}
                      // Include the email in the searchable value so typing an
                      // address matches even when the name is shown.
                      value={`${label} ${candidate.email ?? ""}`}
                      disabled={addingUserId !== null}
                      onSelect={() => void handleAdd(candidate)}
                    >
                      <Avatar className="size-6">
                        {candidate.image ? (
                          <AvatarImage alt={label} src={candidate.image} />
                        ) : null}
                        <AvatarFallback className="text-[10px]">
                          {label.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{label}</span>
                        {candidate.email && candidate.email !== label ? (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {candidate.email}
                          </span>
                        ) : null}
                      </span>
                      {addingUserId === candidate.userId ? (
                        <Loader2 className="ml-auto size-3.5 animate-spin" />
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}
