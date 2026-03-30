"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OrganizationSwitcher,
  UserButton,
  useAuthenticate,
} from "@daveyplate/better-auth-ui";
import Link from "next/link";
import { authClient } from "../../../lib/auth-client";
import { billingClient } from "../../../lib/sdk";

type BillingSummaryResponse = Awaited<
  ReturnType<(typeof billingClient)["getSummary"]>
>;
type BillingUsageResponse = Awaited<
  ReturnType<(typeof billingClient)["getUsage"]>
>;
type BillingLedgerResponse = Awaited<
  ReturnType<(typeof billingClient)["getLedger"]>
>;
type BillingSubscriptionResponse = Awaited<
  ReturnType<(typeof billingClient)["getSubscription"]>
>;

type Organization = {
  id: string;
  name: string;
};

function parseOrganizations(payload: unknown): Organization[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is Organization =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        "name" in item,
    );
  }

  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return parseOrganizations((payload as { data: unknown }).data);
  }

  return [];
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatUsd(value: number | null) {
  if (value === null) return "Not set";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Request failed";
}

export default function BillingPage() {
  const authState = useAuthenticate();
  const sessionState = authState.data as
    | { session?: { activeOrganizationId?: string | null } }
    | null
    | undefined;
  const hasSession = Boolean(sessionState);
  const sessionActiveOrganizationId =
    sessionState?.session?.activeOrganizationId || null;

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [summary, setSummary] = useState<BillingSummaryResponse | null>(null);
  const [usage, setUsage] = useState<BillingUsageResponse | null>(null);
  const [ledger, setLedger] = useState<BillingLedgerResponse | null>(null);
  const [subscription, setSubscription] =
    useState<BillingSubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<
    "checkout" | "portal" | "cancel" | "switch-org" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeOrg = useMemo(
    () => organizations.find((item) => item.id === activeOrgId) || null,
    [organizations, activeOrgId],
  );

  const hasTeamSubscriptionAccess =
    subscription?.status === "active" ||
    subscription?.status === "trialing" ||
    subscription?.status === "past_due";

  const loadBillingData = useCallback(async (teamId: string) => {
    const [summaryRes, usageRes, ledgerRes, subscriptionRes] =
      await Promise.all([
        billingClient.getSummary(teamId),
        billingClient.getUsage(teamId),
        billingClient.getLedger(teamId),
        billingClient.getSubscription(teamId),
      ]);
    setSummary(summaryRes);
    setUsage(usageRes);
    setLedger(ledgerRes);
    setSubscription(subscriptionRes);
  }, []);

  async function performAction(
    action: "checkout" | "portal" | "cancel" | "switch-org",
    run: () => Promise<void>,
  ) {
    setActionBusy(action);
    setError(null);
    setNotice(null);
    try {
      await run();
    } catch (value) {
      setError(toErrorMessage(value));
    } finally {
      setActionBusy(null);
    }
  }

  useEffect(() => {
    async function loadOrganizations() {
      if (!hasSession) return;
      const result = await authClient.organization.list();
      const items = parseOrganizations(result?.data ?? result);
      setOrganizations(items);
      setActiveOrgId(sessionActiveOrganizationId || items[0]?.id || null);
    }
    void loadOrganizations().catch((v) => setError(toErrorMessage(v)));
  }, [hasSession, sessionActiveOrganizationId]);

  useEffect(() => {
    async function loadBilling() {
      if (!activeOrgId) {
        setSummary(null);
        setUsage(null);
        setLedger(null);
        setSubscription(null);
        return;
      }
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        await loadBillingData(activeOrgId);
      } catch (value) {
        setError(toErrorMessage(value));
      } finally {
        setLoading(false);
      }
    }
    void loadBilling();
  }, [activeOrgId, loadBillingData]);

  if (authState.isPending) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center p-8">
        Loading...
      </main>
    );
  }

  if (!sessionState) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center p-8">
        Unable to resolve session.
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">Billing</h1>
          <p className="text-sm text-zinc-600">
            Team-scoped credits and ingestion usage overview.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            href="/dashboard"
          >
            Back to dashboard
          </Link>
          <Link
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            href="/dashboard/team"
          >
            Team
          </Link>
          <Link
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            href="/dashboard/settings"
          >
            Settings
          </Link>
          <OrganizationSwitcher />
          <UserButton />
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
            value={activeOrgId || ""}
            disabled={actionBusy === "switch-org"}
            onChange={(event) => {
              const organizationId = event.target.value || null;
              if (!organizationId) {
                setActiveOrgId(null);
                return;
              }
              void performAction("switch-org", async () => {
                await authClient.organization.setActive({ organizationId });
                setActiveOrgId(organizationId);
              });
            }}
          >
            <option value="" disabled>
              Select organization
            </option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {loading && (
        <p className="rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-600">
          Loading billing data...
        </p>
      )}

      {!loading && summary && (
        <section className="grid gap-4 md:grid-cols-3">
          <article className="rounded-2xl border border-zinc-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Plan
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-900">
              {summary.planFamily}
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Mode: {summary.billingMode}
            </p>
          </article>
          <article className="rounded-2xl border border-zinc-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Pages
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-900">
              {formatNumber(summary.pages.used)} /{" "}
              {formatNumber(summary.pages.limit)}
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Remaining: {formatNumber(summary.pages.remaining)}
            </p>
          </article>
          <article className="rounded-2xl border border-zinc-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Credits
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-900">
              {formatNumber(summary.credits.available)} available
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              Consumed this cycle:{" "}
              {formatNumber(summary.credits.consumedThisCycle)}
            </p>
          </article>
        </section>
      )}

      {!loading && subscription && activeOrgId && (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">
                Team subscription
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Status:{" "}
                <span className="font-medium">{subscription.status}</span>
                {" · "}
                Plan:{" "}
                <span className="font-medium">
                  {subscription.planFamily ?? "none"}
                </span>
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Provider: {subscription.provider}
                {subscription.currentPeriodEnd
                  ? ` · Renews/ends ${new Date(subscription.currentPeriodEnd).toLocaleString()}`
                  : ""}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!hasTeamSubscriptionAccess && (
                <button
                  type="button"
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  disabled={Boolean(actionBusy)}
                  onClick={() => {
                    void performAction("checkout", async () => {
                      const response =
                        await billingClient.createSubscriptionCheckout(
                          activeOrgId,
                          { planFamily: "team_standard", seatCount: 2 },
                        );
                      window.location.href = response.checkoutUrl;
                    });
                  }}
                >
                  {actionBusy === "checkout"
                    ? "Opening checkout..."
                    : "Upgrade to team_standard"}
                </button>
              )}

              {hasTeamSubscriptionAccess && (
                <>
                  <button
                    type="button"
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                    disabled={Boolean(actionBusy)}
                    onClick={() => {
                      void performAction("portal", async () => {
                        const response =
                          await billingClient.createBillingPortal(activeOrgId);
                        if (!response.portalUrl) {
                          setNotice(
                            "Portal created. If no redirect occurred, check your email from Creem.",
                          );
                          return;
                        }
                        window.location.href = response.portalUrl;
                      });
                    }}
                  >
                    {actionBusy === "portal"
                      ? "Opening..."
                      : "Open billing portal"}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm text-red-700 disabled:opacity-50"
                    disabled={Boolean(actionBusy)}
                    onClick={() => {
                      void performAction("cancel", async () => {
                        await billingClient.cancelSubscription(activeOrgId);
                        await loadBillingData(activeOrgId);
                        setNotice("Subscription cancellation scheduled.");
                      });
                    }}
                  >
                    {actionBusy === "cancel"
                      ? "Cancelling..."
                      : "Cancel subscription"}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {!loading && summary && usage && (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-900">Cycle Usage</h2>
          <p className="mt-1 text-xs text-zinc-500">
            {new Date(summary.cycleStartAt).toLocaleString()} -{" "}
            {new Date(summary.cycleEndAt).toLocaleString()}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
              Credits: {formatNumber(usage.totals.creditsConsumed)}
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
              Pages: {formatNumber(usage.totals.pagesConsumed)}
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
              Events: {formatNumber(usage.totals.events)}
            </div>
          </div>
          <div className="mt-3 text-xs text-zinc-500">
            Soft cap: {formatUsd(summary.spendLimits.softCapUsd)} | Hard cap:{" "}
            {formatUsd(summary.spendLimits.hardCapUsd)}
          </div>
        </section>
      )}

      {!loading && ledger && (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            Ledger ({activeOrg?.name || "team"})
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">Feature</th>
                  <th className="px-2 py-2">Event</th>
                  <th className="px-2 py-2">Unit</th>
                  <th className="px-2 py-2">Delta</th>
                  <th className="px-2 py-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.items.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-zinc-500" colSpan={6}>
                      No ledger entries yet.
                    </td>
                  </tr>
                ) : (
                  ledger.items.map((item) => (
                    <tr key={item.id} className="border-t border-zinc-100">
                      <td className="px-2 py-2 text-xs text-zinc-600">
                        {new Date(item.createdAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-2">{item.feature}</td>
                      <td className="px-2 py-2">{item.eventType}</td>
                      <td className="px-2 py-2">{item.unitType}</td>
                      <td className="px-2 py-2">{item.delta}</td>
                      <td className="px-2 py-2">{item.balanceAfter}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
