"use client";

import {
  CreateOrganizationDialog,
  OrganizationMembersCard,
  OrganizationSettingsCards,
  OrganizationsCard,
} from "@daveyplate/better-auth-ui";
import { MailPlus, Plus, Users } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useState } from "react";
import {
  DashboardEmbed,
  DashboardMetaRow,
  DashboardModalShell,
  DashboardSection,
} from "./dashboard-modal-shell";

export function DashboardTeamModal({
  open,
  onOpenChange,
  teamName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName?: string;
}) {
  const resolvedName = teamName || "Personal team";
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <DashboardModalShell
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm" type="button">
            <Plus className="h-4 w-4" />
            Create org
          </Button>
        }
        className="sm:max-w-3xl"
        description="Manage your team profile, members, and invites."
        onOpenChange={onOpenChange}
        open={open}
        title="Team"
      >
        <div className="space-y-3">
          <DashboardSection eyebrow="Team Profile">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  Active organization
                </div>
                <h3 className="mt-4 text-lg font-semibold text-foreground">{resolvedName}</h3>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Team members share workspace access, collaboration context, and organization-level controls.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background px-4 py-3 lg:min-w-[240px]">
                <DashboardMetaRow label="Members" value="12" />
                <DashboardMetaRow label="Pending invites" value="2" />
                <DashboardMetaRow label="Default role" value="Member" />
              </div>
            </div>
          </DashboardSection>

          <DashboardSection eyebrow="Members" meta="Live organization member management from Better Auth UI" title="Members">
            <DashboardEmbed className="[&>*]:min-w-0">
              <OrganizationMembersCard />
            </DashboardEmbed>
          </DashboardSection>

          <DashboardSection
            eyebrow="Organization Controls"
            headerActions={
              <Button onClick={() => setCreateOpen(true)} size="xs" type="button" variant="outline">
                <MailPlus className="h-3.5 w-3.5" />
                Manage orgs
              </Button>
            }
            meta="Lower-frequency org configuration stays available here without leaving the dashboard shell"
            title="Settings & organizations"
          >
            <div className="space-y-3">
              <DashboardEmbed className="[&>*]:min-w-0">
                <OrganizationSettingsCards />
              </DashboardEmbed>
              <DashboardEmbed className="[&>*]:min-w-0">
                <OrganizationsCard />
              </DashboardEmbed>
            </div>
          </DashboardSection>
        </div>
      </DashboardModalShell>
      <CreateOrganizationDialog onOpenChange={setCreateOpen} open={createOpen} />
    </>
  );
}
