"use client";

import {
  AccountsCard,
  ApiKeysCard,
  ChangeEmailCard,
  ChangePasswordCard,
  PasskeysCard,
  SessionsCard,
  TwoFactorCard,
  UpdateAvatarCard,
  UpdateNameCard,
} from "@daveyplate/better-auth-ui";
import { BadgeCheck } from "lucide-react";
import { Avatar, AvatarFallback } from "@sourceweft/ui-web/components/ui/avatar";
import {
  DashboardEmbed,
  DashboardMetaRow,
  DashboardModalShell,
  DashboardSection,
} from "./dashboard-modal-shell";

export function DashboardProfileModal({
  open,
  onOpenChange,
  userName,
  userEmail,
  initials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName?: string;
  userEmail?: string;
  initials: string;
}) {
  return (
    <DashboardModalShell
      className="sm:max-w-2xl"
      description="Manage your account, security, and connected access."
      onOpenChange={onOpenChange}
      open={open}
      title="Profile"
    >
      <div className="space-y-3">
        <DashboardSection eyebrow="Account">
          <div className="flex items-center gap-3">
            <Avatar className="size-12" size="lg">
              <AvatarFallback className="bg-primary text-sm font-semibold text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {userName || "SourceWeft User"}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {userEmail || "Signed in"}
              </p>
              <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-input bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                <BadgeCheck className="h-3 w-3" />
                Personal account
              </div>
            </div>
          </div>
          <div className="mt-4 grid gap-2 rounded-lg border border-border bg-background px-4 py-2.5 sm:grid-cols-2">
            <DashboardMetaRow label="Display name" value={userName || "Not set"} />
            <DashboardMetaRow label="Email" value={userEmail || "No email"} />
          </div>
        </DashboardSection>

        <DashboardSection eyebrow="Profile" meta="Live account components from Better Auth UI">
          <div className="grid gap-3 lg:grid-cols-2">
            <DashboardEmbed className="[&>*]:min-w-0">
              <UpdateAvatarCard />
            </DashboardEmbed>
            <DashboardEmbed className="[&>*]:min-w-0">
              <UpdateNameCard />
            </DashboardEmbed>
            <DashboardEmbed className="[&>*]:min-w-0">
              <ChangeEmailCard />
            </DashboardEmbed>
            <DashboardEmbed className="[&>*]:min-w-0">
              <ChangePasswordCard />
            </DashboardEmbed>
          </div>
        </DashboardSection>

        <DashboardSection eyebrow="Security & Access">
          <div className="grid gap-3 lg:grid-cols-2">
            <DashboardEmbed className="[&>*]:min-w-0">
              <TwoFactorCard />
            </DashboardEmbed>
            <DashboardEmbed className="[&>*]:min-w-0">
              <PasskeysCard />
            </DashboardEmbed>
            <DashboardEmbed className="lg:col-span-2 [&>*]:min-w-0">
              <SessionsCard />
            </DashboardEmbed>
            <DashboardEmbed className="lg:col-span-2 [&>*]:min-w-0">
              <AccountsCard />
            </DashboardEmbed>
          </div>
        </DashboardSection>

        <DashboardSection eyebrow="Developer">
          <div>
            <DashboardEmbed className="[&>*]:min-w-0">
              <ApiKeysCard />
            </DashboardEmbed>
          </div>
        </DashboardSection>
      </div>
    </DashboardModalShell>
  );
}
