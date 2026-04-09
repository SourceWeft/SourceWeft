"use client";

import Link from "next/link";
import { ArrowLeft, MailPlus, MoreHorizontal, Users } from "lucide-react";
import { Avatar, AvatarFallback } from "@sourceweft/ui-web/components/ui/avatar";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  DashboardMetaRow,
  DashboardSection,
} from "../_components/dashboard-modal-shell";

const mockMembers = [
  { name: "Tina Chen", email: "tina@sourceweft.com", role: "Owner", status: "Active" },
  { name: "Marcus Reed", email: "marcus@sourceweft.com", role: "Admin", status: "Active" },
  { name: "Priya Kapoor", email: "priya@sourceweft.com", role: "Member", status: "Invited" },
];

const mockInvites = [
  { email: "ops@sourceweft.com", role: "Admin", sentAt: "Sent 2 hours ago" },
  { email: "design@sourceweft.com", role: "Member", sentAt: "Sent yesterday" },
];

function initials(value: string) {
  return value
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function RoleBadge({ value }: { value: string }) {
  return (
    <span className="rounded-full border border-input bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
      {value}
    </span>
  );
}

export default function TeamSettingsPage() {
  return (
    <main className="flex flex-1 flex-col bg-background">
      <header className="border-b border-border bg-background">
        <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-6">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Team Preview
            </p>
            <h1 className="text-base font-semibold text-foreground">Organization controls</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" type="button">
              <MailPlus className="h-4 w-4" />
              Invite member
            </Button>
            <Button asChild size="sm" type="button" variant="outline">
              <Link href="/dashboard">
                <ArrowLeft className="h-4 w-4" />
                Back to dashboard
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        <DashboardSection eyebrow="Team Profile">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                Active organization
              </div>
              <h2 className="mt-4 text-xl font-semibold text-foreground">SourceWeft Labs</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Team members share workspace access, collaboration context, and organization-level controls.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3 lg:min-w-[280px]">
              <DashboardMetaRow label="Members" value="12" />
              <DashboardMetaRow label="Pending invites" value="2" />
              <DashboardMetaRow label="Default role" value="Member" />
            </div>
          </div>
        </DashboardSection>

        <DashboardSection eyebrow="Members" meta="People with access to this team" title="Members">
          <div className="space-y-2">
            {mockMembers.map((member, index) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3 transition-colors hover:bg-accent/40"
                key={member.email}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar size="sm">
                    <AvatarFallback className={cn("text-xs font-medium", index === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                      {initials(member.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{member.name}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="truncate">{member.email}</span>
                      <span>·</span>
                      <span>{member.status}</span>
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RoleBadge value={member.role} />
                  <Button size="icon-xs" type="button" variant="outline">
                    <MoreHorizontal className="size-3" />
                    <span className="sr-only">More actions</span>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DashboardSection>

        <DashboardSection eyebrow="Invites" meta="Invitations that are still waiting for a response" title="Pending invites">
          <div className="space-y-2">
            {mockInvites.map((invite) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3 transition-colors hover:bg-accent/40"
                key={invite.email}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{invite.email}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>{invite.role}</span>
                    <span>·</span>
                    <span>{invite.sentAt}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="xs" type="button" variant="outline">
                    Resend
                  </Button>
                  <Button size="xs" type="button" variant="ghost">
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DashboardSection>
      </div>
    </main>
  );
}
