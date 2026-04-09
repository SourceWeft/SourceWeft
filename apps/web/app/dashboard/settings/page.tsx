"use client";

import type * as React from "react";
import Link from "next/link";
import { ArrowLeft, BadgeCheck, KeyRound, Link2, Monitor, ShieldCheck } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DashboardMetaRow,
  DashboardSection,
} from "../_components/dashboard-modal-shell";

function MockRow({
  icon: Icon,
  title,
  meta,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta: string;
  action: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 rounded-lg border border-border bg-card p-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
        </div>
      </div>
      <Button size="xs" type="button" variant="outline">
        {action}
      </Button>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <main className="flex flex-1 flex-col bg-background">
      <header className="border-b border-border bg-background">
        <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-6">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Profile Preview
            </p>
            <h1 className="text-base font-semibold text-foreground">
              Personal account controls
            </h1>
          </div>
          <Button asChild size="sm" type="button" variant="outline">
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        <DashboardSection
          eyebrow="Account"
          meta="The primary entry now lives under the avatar menu, but this route keeps the same dashboard shell styling."
          title="Profile"
        >
          <div className="rounded-lg border border-border bg-background px-4 py-2.5">
            <DashboardMetaRow label="Display name" value="SourceWeft User" />
            <DashboardMetaRow label="Email" value="hello@sourceweft.com" />
          </div>
        </DashboardSection>

        <div className="grid gap-4 lg:grid-cols-2">
          <DashboardSection eyebrow="Security" title="Secure your account">
            <div className="space-y-3">
              <MockRow action="Change" icon={ShieldCheck} meta="Password last updated 23 days ago" title="Password" />
              <MockRow action="Enable" icon={BadgeCheck} meta="Add an extra verification step for new devices" title="Two-factor authentication" />
              <MockRow action="Add" icon={KeyRound} meta="Register a passkey for faster sign-in" title="Passkeys" />
            </div>
          </DashboardSection>

          <DashboardSection eyebrow="Access" title="Sessions and devices">
            <div className="space-y-3">
              <MockRow action="Review" icon={Monitor} meta="MacBook Pro · San Francisco · Active now" title="Current session" />
              <MockRow action="View all" icon={Monitor} meta="2 other active sessions across recent devices" title="Recent devices" />
            </div>
          </DashboardSection>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <DashboardSection eyebrow="Connections" title="Linked providers">
            <div className="space-y-3">
              <MockRow action="Manage" icon={Link2} meta="Google connected for sign-in" title="OAuth providers" />
              <MockRow action="Review" icon={Link2} meta="Email OTP and magic link available" title="Sign-in methods" />
            </div>
          </DashboardSection>

          <DashboardSection eyebrow="Developer" title="API access">
            <div className="space-y-3">
              <MockRow action="Create" icon={KeyRound} meta="Generate scoped keys for personal workflows" title="API keys" />
              <MockRow action="Open" icon={ShieldCheck} meta="Review token usage and recent key activity" title="Access logs" />
            </div>
          </DashboardSection>
        </div>
      </div>
    </main>
  );
}
