"use client";

import { useState } from "react";
import type { PlanConfig } from "../../_landing/pricing-config";

function formatPrice(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(0)}`;
}

function yearlyDiscount(monthly: number, yearly: number): number {
  if (monthly === 0) return 0;
  const monthlyAnnual = monthly * 12;
  return Math.round(((monthlyAnnual - yearly) / monthlyAnnual) * 100);
}

export function PricingToggle({ plans }: { plans: PlanConfig[] }) {
  const [yearly, setYearly] = useState(false);

  return (
    <div>
      {/* Toggle */}
      <div className="mb-10 flex items-center justify-center gap-3">
        <span
          className={`text-sm transition-colors ${
            !yearly
              ? "text-zinc-900 dark:text-white"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
        >
          Monthly
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={yearly}
          onClick={() => setYearly((v) => !v)}
          className="relative inline-flex h-6 w-11 items-center rounded-full border border-zinc-300 bg-zinc-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-white/20 dark:bg-zinc-800 dark:focus-visible:ring-white/40"
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-zinc-900 shadow transition-transform duration-200 dark:bg-white ${
              yearly ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
        <span
          className={`text-sm transition-colors ${
            yearly
              ? "text-zinc-900 dark:text-white"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
        >
          Yearly
          {yearly && (
            <span className="ml-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
              2 months free
            </span>
          )}
        </span>
      </div>

      {/* Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const price = yearly ? plan.yearlyPrice : plan.monthlyPrice;
          const discount =
            yearly && plan.monthlyPrice > 0
              ? yearlyDiscount(plan.monthlyPrice, plan.yearlyPrice)
              : 0;

          return (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-2xl border p-6 transition-all duration-200 ${
                plan.highlighted
                  ? "border-zinc-300 bg-white shadow-lg dark:border-white/30 dark:bg-zinc-800/80 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_8px_32px_rgba(0,0,0,0.4)]"
                  : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 hover:bg-white hover:shadow-sm dark:border-white/8 dark:bg-zinc-900/60 dark:hover:border-white/16 dark:hover:bg-zinc-900/60"
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full border border-zinc-200 bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:border-white/20 dark:bg-zinc-700 dark:text-white">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-4">
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {plan.name}
                </p>
                <div className="mt-2 flex items-end gap-1">
                  <span className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-white">
                    {formatPrice(price)}
                  </span>
                  {price > 0 && (
                    <span className="mb-1 text-sm text-zinc-400 dark:text-zinc-500">
                      /{yearly ? "yr" : "mo"}
                      {plan.id === "team" ? " / seat" : ""}
                    </span>
                  )}
                </div>
                <p
                  className={`mt-1 text-xs text-emerald-600 dark:text-emerald-400 ${discount > 0 ? "visible" : "invisible"}`}
                >
                  2 months free vs monthly
                </p>
                <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500">
                  {plan.description}
                </p>
              </div>

              <ul className="mb-6 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300"
                  >
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-400"
                      fill="none"
                      viewBox="0 0 16 16"
                    >
                      <path
                        d="M3 8l3.5 3.5L13 4.5"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <a
                href={plan.ctaHref}
                className={`block w-full rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-colors ${
                  plan.highlighted
                    ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                    : "border border-zinc-200 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
                }`}
              >
                {plan.cta}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
