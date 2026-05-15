"use client";

import * as React from "react";
import { Check, ChevronDown, CreditCard, Sparkles } from "lucide-react";
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
import { billingCheckoutEnabled } from "../../../lib/deployment-config";
import { billingClient } from "../../../lib/sdk";
import { getPricingConfig } from "../../_landing/pricing-config";
import {
  DashboardMetaRow,
  DashboardModalShell,
  DashboardSection,
} from "./dashboard-modal-shell";
import {
  getVisibleTeamOrganizations,
  getPersonalOrganization,
  isPersonalOrganization,
} from "./dashboard-team-selector-shared";
import { DashboardPricingModal } from "./dashboard-pricing-modal";

type BillingSummary = Awaited<ReturnType<typeof billingClient.getSummary>>;

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
    <article className="rounded-2xl border border-border/80 bg-background/95 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
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
    (orgs ?? []) as Array<{
      id: string;
      metadata?: unknown;
      name: string;
      slug: string;
    }>,
  );
  const personalOrg = getPersonalOrganization(
    (orgs ?? []) as Array<{
      id: string;
      metadata?: unknown;
      name: string;
      slug: string;
    }>,
  );
  const activeOrgRecord = activeOrg as
    | { id: string; metadata?: unknown; name: string }
    | null
    | undefined;
  const isPersonalActive =
    !activeOrgRecord || isPersonalOrganization(activeOrgRecord);

  async function handleSwitch(orgId: string) {
    try {
      await authClient.organization.setActive({ organizationId: orgId });
      setOpen(false);
    } catch {
      toast.error("Failed to switch team.");
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
            {isPersonalActive
              ? "P"
              : (activeOrgRecord?.name.slice(0, 2).toUpperCase() ?? "P")}
          </div>
          <span className="truncate text-sm text-foreground">
            {isPersonalActive
              ? (personalOrg?.name ?? activeOrgRecord?.name)
              : activeOrgRecord?.name}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1.5">
        {personalOrg ? (
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
              isPersonalActive && "bg-accent/60",
            )}
            onClick={() => void handleSwitch(personalOrg.id)}
            type="button"
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">P</div>
            <span className="flex-1 truncate">{personalOrg.name}</span>
            {isPersonalActive && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
          </button>
        ) : null}
        {orgList.length > 0 && (
          <>
            <div className="my-1 border-t border-border/60" />
            {orgList.map((org) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  activeOrgRecord?.id === org.id && "bg-accent/60",
                )}
                key={org.id}
                onClick={() => void handleSwitch(org.id)}
                type="button"
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  {org.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="flex-1 truncate">{org.name}</span>
                {activeOrgRecord?.id === org.id && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
              </button>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function DashboardBillingModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: orgs } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const allOrgs = (orgs ?? []) as Array<{
    id: string;
    metadata?: unknown;
    name: string;
    slug?: string;
  }>;
  const activeOrgRecord = activeOrg as
    | { id: string; metadata?: unknown; name: string }
    | null
    | undefined;
  const personalOrg = getPersonalOrganization(allOrgs);
  const billingTeamId = activeOrgRecord?.id ?? personalOrg?.id ?? null;
  const isTeam = Boolean(activeOrgRecord && !isPersonalOrganization(activeOrgRecord));

  const [pricingOpen, setPricingOpen] = React.useState(false);
  const [billingPeriod, setBillingPeriod] = React.useState<"monthly" | "yearly">("yearly");
  const [pricingSummary, setPricingSummary] =
    React.useState<BillingSummary | null>(null);
  const plans = getPricingConfig();

  React.useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      if (!open || !billingTeamId) {
        setPricingSummary(null);
        return;
      }

      try {
        const nextSummary = await billingClient.getSummary(billingTeamId);
        if (!cancelled) {
          setPricingSummary(nextSummary);
        }
      } catch {
        if (!cancelled) {
          setPricingSummary(null);
        }
      }
    }

    void loadSummary();

    return () => {
      cancelled = true;
    };
  }, [billingTeamId, open]);

  const content = isTeam
    ? {
        description: "Manage plan, payment details, and subscription state for this team.",
        plan: "Team",
        status: "Active",
        cycle: "Renews on May 12, 2026",
        nextPayment: "$80.00",
        usageLabel: "11,600 / 80,000 credits",
        usageValue: "14%",
        usageProgress: 14,
        seats: "4 active seats",
        paymentMethod: "Mastercard ending in 2244",
      }
    : {
        description: "Manage plan, payment details, and subscription state for your personal account.",
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
    <>
      <DashboardModalShell
        actions={<OrgSwitcher />}
        className="sm:max-w-3xl"
        description={content.description}
        onOpenChange={onOpenChange}
        open={open}
        title="Billing"
      >
      <div className="space-y-3">
        <DashboardSection eyebrow="Current Plan">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                {isTeam ? "Team billing" : "Personal billing"}
              </div>
              <h3 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
                {content.plan}
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {content.status} · {content.cycle}
              </p>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                A single billing surface for usage, payment details, and subscription state without leaving the active workspace shell.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-full border border-border bg-background px-2 py-0.5">Auto-renew enabled</span>
                <span className="rounded-full border border-border bg-background px-2 py-0.5">Tax profile complete</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {billingCheckoutEnabled ? (
                <>
                  <Button onClick={() => setPricingOpen(true)} size="sm" type="button" variant="outline">
                    View pricing
                  </Button>
                  <Button size="sm" type="button">
                    Manage plan
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </DashboardSection>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Plan" meta={content.status} value={content.plan} />
          <SummaryCard label="Current usage" meta={content.usageLabel} value={content.usageValue} />
          <SummaryCard label="Next payment" meta={content.cycle} value={content.nextPayment} />
          <SummaryCard
            label={isTeam ? "Seats" : "Status"}
            meta={isTeam ? "Members on this plan" : "Account billing scope"}
            value={content.seats}
          />
        </div>

        <DashboardSection
          eyebrow="Billing Health"
          meta="A compact status surface inspired by workspace control centers"
          title="Account health"
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-border bg-background px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Payment reliability</p>
              <p className="mt-1 text-sm font-medium text-foreground">No failed charges</p>
            </div>
            <div className="rounded-xl border border-border bg-background px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Usage trend</p>
              <p className="mt-1 text-sm font-medium text-foreground">+8% vs last cycle</p>
            </div>
            <div className="rounded-xl border border-border bg-background px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Plan fit</p>
              <p className="mt-1 text-sm font-medium text-foreground">Within recommended range</p>
            </div>
          </div>
        </DashboardSection>

        <div className="grid gap-3 lg:grid-cols-2">
          <DashboardSection eyebrow="Payment Method" meta="Keep your renewal path uninterrupted" title="Default payment method">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="rounded-lg border border-border bg-card p-2 text-muted-foreground">
                    <CreditCard className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">{content.paymentMethod}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Auto-pay enabled for upcoming renewals</p>
                  </div>
                </div>
                <Button size="xs" type="button" variant="outline">
                  Update
                </Button>
              </div>
            </div>
          </DashboardSection>

          <DashboardSection eyebrow="Usage" meta="Live product usage summary" title="Current cycle usage">
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

        <DashboardSection
          eyebrow="Scope"
          meta="Clarifies whether charges apply to your personal account or active organization"
          title="Billing context"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <DashboardMetaRow label="Personal" value="Individual account usage and billing controls" />
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3">
              <DashboardMetaRow
                label="Team"
                value="Organization-level subscription and shared billing"
              />
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-background px-4 py-3 text-xs text-muted-foreground">
            Switch between personal and team workspaces using the selector above.
          </div>
        </DashboardSection>
      </div>
    </DashboardModalShell>
    {billingCheckoutEnabled ? (
      <DashboardPricingModal
        billingPeriod={billingPeriod}
        onBillingPeriodChange={setBillingPeriod}
        onOpenChange={setPricingOpen}
        open={pricingOpen}
        plans={plans}
        summary={pricingSummary}
      />
    ) : null}
    </>
  );
}
