"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, CreditCard, Download, Receipt, Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Progress } from "@sourceweft/ui-web/components/ui/progress";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sourceweft/ui-web/components/ui/popover";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { toast } from "sonner";
import { authClient } from "../../../lib/auth-client";
import {
  DashboardMetaRow,
  DashboardSection,
} from "../_components/dashboard-modal-shell";
import { getVisibleTeamOrganizations } from "../_components/dashboard-team-selector-shared";

const invoices = [
  { period: "Apr 2026", amount: "$20.00", status: "Paid" },
  { period: "Mar 2026", amount: "$20.00", status: "Paid" },
  { period: "Feb 2026", amount: "$20.00", status: "Paid" },
];

function SummaryCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <article className="rounded-2xl border border-border bg-background p-4">
      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 text-xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
    </article>
  );
}

function OrgSwitcher({
  className,
}: {
  className?: string;
}) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [open, setOpen] = React.useState(false);

  const orgList = getVisibleTeamOrganizations(
    (orgs ?? []) as Array<{ id: string; name: string; slug: string }>,
  );
  const isPersonalActive = !activeOrg;

  async function handleSwitch(orgId: string | null) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      setOpen(false);
    } catch {
      toast.error("Failed to switch workspace.");
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 aria-expanded:bg-accent/50",
            className,
          )}
          type="button"
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-foreground">
            {isPersonalActive ? "P" : (activeOrg?.name.slice(0, 2).toUpperCase() ?? "P")}
          </div>
          <span className="truncate text-sm text-foreground">
            {isPersonalActive ? "Personal workspace" : activeOrg?.name}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1.5">
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
            isPersonalActive && "bg-accent/60",
          )}
          onClick={() => void handleSwitch(null)}
          type="button"
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">P</div>
          <span className="flex-1 truncate">Personal workspace</span>
          {isPersonalActive && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
        </button>
        {orgList.length > 0 && (
          <>
            <div className="my-1 border-t border-border/60" />
            {orgList.map((org) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  activeOrg?.id === org.id && "bg-accent/60",
                )}
                key={org.id}
                onClick={() => void handleSwitch(org.id)}
                type="button"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  {org.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="flex-1 truncate">{org.name}</span>
                {activeOrg?.id === org.id && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
              </button>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default function BillingPage() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const isTeam = !!activeOrg;

  const content = isTeam
    ? {
        description: "Manage plan, invoices, and payment details for this team.",
        plan: "Team",
        status: "Trialing",
        cycle: "Trial ends on May 12, 2026",
        nextPayment: "$80.00",
        usageLabel: "11,600 / 80,000 credits",
        usageValue: "14%",
        usageProgress: 14,
        seats: "4 active seats",
        paymentMethod: "Mastercard ending in 2244",
      }
    : {
        description: "Manage plan, invoices, and payment details for your personal account.",
        plan: "Pro",
        status: "Active",
        cycle: "Renews on May 7, 2026",
        nextPayment: "$20.00",
        usageLabel: "2,400 / 20,000 credits",
        usageValue: "12%",
        usageProgress: 12,
        seats: "Solo",
        paymentMethod: "Visa ending in 4242",
      };

  return (
    <main className="flex flex-1 flex-col bg-background">
      <header className="border-b border-border bg-background">
        <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-6">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Billing Preview
            </p>
            <h1 className="text-base font-semibold text-foreground">Billing</h1>
          </div>
          <div className="flex items-center gap-2">
            <OrgSwitcher />
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
        <DashboardSection eyebrow="Current Plan" meta={content.description}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                {isTeam ? "Team billing" : "Personal billing"}
              </div>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
                {content.plan}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {content.status} · {content.cycle}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" type="button" variant="outline">
                View pricing
              </Button>
              <Button size="sm" type="button">
                Manage plan
              </Button>
            </div>
          </div>
        </DashboardSection>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Plan" meta={content.status} value={content.plan} />
          <SummaryCard label="Current usage" meta={content.usageLabel} value={content.usageValue} />
          <SummaryCard label="Next payment" meta={content.cycle} value={content.nextPayment} />
          <SummaryCard
            label={isTeam ? "Seats" : "Status"}
            meta={isTeam ? "Members on this plan" : "Account billing scope"}
            value={content.seats}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <DashboardSection eyebrow="Payment Method" title="Default payment method">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="rounded-lg border border-border bg-card p-2 text-muted-foreground">
                    <CreditCard className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">{content.paymentMethod}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Auto-pay enabled for upcoming invoices</p>
                  </div>
                </div>
                <Button size="xs" type="button" variant="outline">
                  Update
                </Button>
              </div>
            </div>
          </DashboardSection>

          <DashboardSection eyebrow="Usage" title="Current cycle usage">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-foreground">Credits</span>
                <span className="text-muted-foreground">{content.usageLabel}</span>
              </div>
              <Progress className="mt-3 h-2 bg-muted/80" value={content.usageProgress} />
              <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-card px-3 py-2">Pages ingested this cycle: 312</div>
                <div className="rounded-lg border border-border bg-card px-3 py-2">
                  {isTeam ? "4 shared workspaces active" : "Personal notebooks only"}
                </div>
              </div>
            </div>
          </DashboardSection>
        </div>

        <DashboardSection eyebrow="Invoices" meta="Recent billing history" title="Invoices">
          <div className="space-y-2">
            {invoices.map((invoice) => (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3 transition-colors hover:bg-accent/40"
                key={invoice.period}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="rounded-lg border border-border bg-card p-2 text-muted-foreground">
                    <Receipt className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{invoice.period}</p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{invoice.amount}</span>
                      <span>·</span>
                      <span>{invoice.status}</span>
                    </div>
                  </div>
                </div>
                <Button size="xs" type="button" variant="outline">
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </div>
            ))}
          </div>
        </DashboardSection>

        <DashboardSection eyebrow="Scope" title="Billing context">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <DashboardMetaRow label="Personal" value="Individual account usage and invoices" />
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <DashboardMetaRow label="Team" value="Organization-level subscription and shared billing" />
            </div>
          </div>
        </DashboardSection>
      </div>
    </main>
  );
}
