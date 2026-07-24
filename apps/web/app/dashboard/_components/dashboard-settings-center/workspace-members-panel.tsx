"use client";

import * as React from "react";
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

const ASSIGNABLE_ROLES: {
  value: WorkspaceRole;
  label: string;
  hint: string;
}[] = [
  {
    value: "workspace_admin",
    label: "Admin",
    hint: "Manage members, credentials and settings",
  },
  { value: "editor", label: "Editor", hint: "Create and edit content" },
  { value: "viewer", label: "Viewer", hint: "Read-only access" },
];

function roleLabel(role: WorkspaceRole) {
  return ASSIGNABLE_ROLES.find((entry) => entry.value === role)?.label ?? role;
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
  const { workspaceId, organizationId } = useDashboardChatState();
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id ?? null;
  const organizationMembers = useOrganizationMembers();

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
    if (!workspaceId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await workspaceClient.listWorkspaceMembers(workspaceId);
      setMembers(result.items);
    } catch {
      setLoadError("Could not load workspace members.");
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

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
    if (!workspaceId || role === member.role) return;
    setPendingUserId(member.userId);
    try {
      await workspaceClient.updateWorkspaceMemberRole(
        workspaceId,
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
      toast.success(`${displayName(member)} is now ${roleLabel(role)}`);
    } catch {
      toast.error("Could not change this member's role.");
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleRemove(member: WorkspaceMember) {
    if (!workspaceId) return;
    setPendingUserId(member.userId);
    try {
      await workspaceClient.removeWorkspaceMember(workspaceId, member.userId);
      setMembers((value) =>
        value.filter((entry) => entry.userId !== member.userId),
      );
      toast.success(`${displayName(member)} removed from workspace`);
    } catch {
      toast.error("Could not remove this member.");
    } finally {
      setPendingUserId(null);
      setRemoveTarget(null);
    }
  }

  async function handleAdd(candidate: OrganizationMember) {
    if (!workspaceId) return;
    setAddingUserId(candidate.userId);
    try {
      await workspaceClient.addWorkspaceMember(workspaceId, {
        userId: candidate.userId,
        role: addRole,
      });
      toast.success(
        `${candidate.name || candidate.email || "Member"} added as ${roleLabel(addRole)}`,
      );
      setAddOpen(false);
      setAddRole("editor");
      await refresh();
    } catch {
      toast.error("Could not add that member.");
    } finally {
      setAddingUserId(null);
    }
  }

  if (!workspaceId || !organizationId) {
    return (
      <p className="px-1 py-6 text-sm text-muted-foreground">
        Select a workspace to manage its members.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Workspace members</h3>
          <p className="text-xs text-muted-foreground">
            Who can see and work inside this workspace. Team owners and admins
            can always administer it.
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
            Add member
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading members...
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
            Retry
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
                        (you)
                      </span>
                    ) : null}
                    {member.source === "derived" ? (
                      <Badge
                        className="gap-1 px-1.5 py-0 text-[10px]"
                        variant="secondary"
                      >
                        <ShieldCheck className="size-2.5" />
                        Team {member.organizationRole || "member"}
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
                          {role.label}
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
                    <span className="sr-only">Remove member</span>
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
            <DialogTitle>Remove member?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {removeTarget ? displayName(removeTarget) : "This member"} will lose
            access to this workspace. They remain part of the team.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={pendingUserId === removeTarget?.userId}
              onClick={() => removeTarget && void handleRemove(removeTarget)}
              type="button"
              variant="destructive"
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="gap-3">
          <DialogHeader>
            <DialogTitle>Add a workspace member</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Pick a teammate to give access to this workspace. To bring someone
            new onto the team, invite them from the Team panel first.
          </p>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">Role for new members</span>
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
                      <span>{role.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {role.hint}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Command className="rounded-lg border">
            <CommandInput placeholder="Search teammates by name or email..." />
            <CommandList>
              <CommandEmpty>
                {organizationMembers.length === 0
                  ? "No teammates found."
                  : "Everyone on the team is already in this workspace."}
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
