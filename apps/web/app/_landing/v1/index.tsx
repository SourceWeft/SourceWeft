"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Reveal } from "./motion";
import styles from "./motion.module.css";
import {
  ArrowRight,
  Download,
  Brain,
  Check,
  Database,
  FileText,
  Layers,
  LayoutDashboard,
  LoaderCircle,
} from "lucide-react";
import { LocaleLink } from "../../[locale]/_components/locale-link";
import { useTranslations } from "next-intl";
import { SourceWeftFooter } from "../components/sourceweft-footer";
import { SourceWeftHeader } from "../components/sourceweft-header";
import { SourceWeftBrandMark } from "../components/sourceweft-brand";
import {
  type LandingAuthState,
  useLandingAuthState,
} from "../components/use-landing-auth-state";
import { getPricingConfig } from "../pricing-config";
import { useDeploymentCapabilities } from "../../../lib/billing-edition/capabilities";
import { PricingToggle } from "./pricing-toggle";

// ─── Hero ─────────────────────────────────────────────────────────────────────

function HeroSection({
  authState,
  marketStats,
}: {
  authState: LandingAuthState;
  marketStats: ReactNode;
}) {
  const t = useTranslations("landing");
  const primaryHref = authState.isSignedIn ? "/dashboard" : "/auth/sign-in";
  const primaryLabel = authState.isSignedIn
    ? t("hero.ctaSignedIn")
    : t("hero.ctaSignedOut");

  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-28">
      {/* Grid + glow background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            radial-gradient(ellipse 70% 50% at 50% -10%, rgba(0,0,0,0.04) 0%, transparent 70%),
            linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)
          `,
          backgroundSize: "100% 100%, 48px 48px, 48px 48px",
        }}
        // Dark mode override via inline style won't work — handled via CSS class below
      />
      {/* Dark mode grid overlay */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden dark:block"
        style={{
          backgroundImage: `
            radial-gradient(ellipse 70% 50% at 50% -10%, rgba(255,255,255,0.06) 0%, transparent 70%),
            linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
          `,
          backgroundSize: "100% 100%, 48px 48px, 48px 48px",
        }}
      />

      <div className="relative mx-auto max-w-6xl px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* Left — copy */}
          <div className={styles.entrance}>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/5 dark:text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {t("hero.badge")}
            </div>

            <h1 className="text-4xl font-bold tracking-tight text-balance text-zinc-900 md:text-5xl lg:text-[3.25rem] lg:leading-[1.15] dark:text-white">
              {t("hero.headlineLine1")}
              <span className={`${styles.outcome} text-zinc-400`}>
                {t("hero.headlineLine2")}
              </span>
            </h1>

            <p className="mt-5 max-w-md text-base leading-relaxed text-zinc-500 md:text-lg dark:text-zinc-400">
              {t("hero.subtitle")}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={primaryHref}
                className={
                  authState.isSignedIn
                    ? "group inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
                    : "group inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                }
              >
                {authState.isSignedIn ? (
                  <LayoutDashboard className="size-4" />
                ) : null}
                {primaryLabel}
                {authState.isSignedIn ? null : (
                  <ArrowRight
                    aria-hidden="true"
                    className="h-4 w-4 motion-safe:transition-transform motion-safe:group-hover:translate-x-1"
                  />
                )}
              </Link>
              <LocaleLink
                href="/download"
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
              >
                <Download aria-hidden className="h-4 w-4" />
                {t("hero.download")}
              </LocaleLink>
            </div>

            <div className="mt-10 border-t border-zinc-200 pt-8 dark:border-white/8">
              {marketStats}
            </div>
          </div>

          {/* Illustrative task workflow, not a live execution. */}
          <div className="min-w-0" data-nosnippet>
            <Reveal
              demo
              className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-zinc-900/80"
            >
              <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-white/8">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full bg-emerald-500"
                />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("hero.demo.workspace")}
                </span>
              </div>
              <div className="space-y-5 p-5">
                <div className={`${styles.request} flex justify-end`}>
                  <div className="max-w-[90%] rounded-xl rounded-tr-sm bg-zinc-100 px-4 py-3 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100">
                    {t("hero.demo.request")}
                  </div>
                </div>
                <div className={`${styles.response} flex gap-3`}>
                  <SourceWeftBrandMark className="mt-0.5 h-6 w-6 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-4">
                    <div
                      className={`${styles.status} ${styles.summary} text-sm leading-relaxed text-zinc-600 dark:text-zinc-300`}
                    >
                      <p className={styles.pending}>{t("hero.demo.working")}</p>
                      <p className={styles.complete}>{t("hero.demo.reply")}</p>
                    </div>
                    <ul className="space-y-3">
                      {(t.raw("hero.demo.tasks") as string[]).map(
                        (task, index) => (
                          <li
                            key={task}
                            className={`${styles.task} flex items-start gap-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400`}
                            style={{ "--task-index": index } as CSSProperties}
                          >
                            <span
                              className={`${styles.status} mt-0.5 h-3.5 w-3.5 shrink-0`}
                              aria-hidden
                            >
                              <LoaderCircle
                                className={`${styles.pending} ${styles.spinner} h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400`}
                              />
                              <Check
                                className={`${styles.complete} h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400`}
                              />
                            </span>
                            <span className={styles.status}>
                              <span className={styles.pending}>
                                {
                                  (t.raw("hero.demo.activeTasks") as string[])[
                                    index
                                  ]
                                }
                              </span>
                              <span className={styles.complete}>{task}</span>
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
                    <div
                      className={`${styles.artifact} rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-zinc-800/60`}
                    >
                      <div className="flex items-center gap-3">
                        <FileText
                          aria-hidden
                          className="h-5 w-5 shrink-0 text-zinc-500"
                        />
                        <div>
                          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                            {t("hero.demo.artifact")}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {t("hero.demo.status")}
                          </p>
                        </div>
                      </div>
                      <p className="mt-3 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                        {t("hero.demo.sources")}
                      </p>
                    </div>
                    <p
                      className={`${styles.next} text-xs text-zinc-500 dark:text-zinc-400`}
                    >
                      {t("hero.demo.next")}
                    </p>
                  </div>
                </div>
              </div>
              <div className="border-t border-zinc-100 px-4 py-3 dark:border-white/8">
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-white/10 dark:bg-zinc-800/60">
                  <span className="flex-1 text-sm text-zinc-400 dark:text-zinc-500">
                    {t("hero.demo.input")}
                  </span>
                  <ArrowRight aria-hidden className="h-4 w-4 text-zinc-400" />
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Social proof strip ───────────────────────────────────────────────────────

function SocialProof() {
  const t = useTranslations("landing.socialProof");
  const roleKeys = [
    "researchers",
    "writers",
    "developers",
    "students",
  ] as const;
  return (
    <section className="border-y border-zinc-200 py-10 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <p className="mb-8 text-center text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
          {t("heading")}
        </p>
        <div className="flex flex-wrap justify-center gap-x-12 gap-y-6">
          {roleKeys.map((key) => (
            <div key={key} className="text-center">
              <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                {t(`roles.${key}.title`)}
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-600">
                {t(`roles.${key}.desc`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Features ─────────────────────────────────────────────────────────────────

function FeaturesSection() {
  const t = useTranslations("landing.features");
  const features = [
    {
      key: "agents",
      icon: <Brain aria-hidden="true" className="h-5 w-5" />,
    },
    {
      key: "connect",
      icon: <Database aria-hidden="true" className="h-5 w-5" />,
    },
    {
      key: "create",
      icon: <Layers aria-hidden="true" className="h-5 w-5" />,
    },
  ] as const;

  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 max-w-xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            {t("eyebrow")}
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            {t("heading")}
          </h2>
          <p className="mt-3 text-zinc-500 dark:text-zinc-400">{t("intro")}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {features.map((f, index) => (
            <Reveal
              delay={index * 100}
              key={f.key}
              className="group rounded-2xl border border-zinc-200 bg-zinc-50 p-6 transition-all duration-200 motion-safe:hover:-translate-y-1 hover:border-zinc-300 hover:bg-white hover:shadow-sm dark:border-white/8 dark:bg-zinc-900/40 dark:hover:border-white/16 dark:hover:bg-zinc-900/60"
            >
              <div className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-300">
                {f.icon}
              </div>
              <h3 className="mb-2 text-base font-semibold text-zinc-900 dark:text-white">
                {t(`items.${f.key}.title`)}
              </h3>
              <p className="mb-4 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                {t(`items.${f.key}.description`)}
              </p>
              <ul className="space-y-1.5">
                {(t.raw(`items.${f.key}.bullets`) as string[]).map((b) => (
                  <li
                    key={b}
                    className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500"
                  >
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                    {b}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── How it works ─────────────────────────────────────────────────────────────

function HowItWorks() {
  const t = useTranslations("landing.howItWorks");
  const steps = [
    {
      num: "01",
      key: "step1",
      visual: (
        <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-5 dark:border-white/8 dark:bg-zinc-900/60">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {t("visual.request")}
          </p>
          {["context", "result"].map((key) => (
            <div
              key={key}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-500 dark:border-white/8 dark:bg-zinc-800/60 dark:text-zinc-400"
            >
              <FileText aria-hidden className="h-4 w-4 shrink-0" />
              {t(`visual.${key}`)}
            </div>
          ))}
        </div>
      ),
    },
    {
      num: "02",
      key: "step2",
      visual: (
        <ol className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-5 dark:border-white/8 dark:bg-zinc-900/60">
          {(t.raw("visual.agents") as string[]).map((task, index) => (
            <li
              key={task}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3 text-sm text-zinc-600 dark:border-white/8 dark:bg-zinc-800/60 dark:text-zinc-300"
            >
              <span className="text-xs text-zinc-400">0{index + 1}</span>
              {task}
              <Check
                aria-hidden
                className="ml-auto h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
            </li>
          ))}
        </ol>
      ),
    },
    {
      num: "03",
      key: "step3",
      visual: (
        <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-5 text-xs dark:border-white/8 dark:bg-zinc-900/60">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-zinc-100 px-3 py-2 text-zinc-800 dark:bg-zinc-700/80 dark:text-zinc-100">
              {t("visual.review")}
            </div>
          </div>
          <div className="flex gap-2">
            <SourceWeftBrandMark className="mt-0.5 h-5 w-5 shrink-0 rounded-full" />
            <div className="space-y-3 rounded-lg rounded-tl-sm border border-zinc-100 bg-white px-3 py-3 leading-relaxed text-zinc-700 dark:border-white/8 dark:bg-zinc-800/60 dark:text-zinc-200">
              <p>{t("visual.reply")}</p>
              <p className="flex items-center gap-2 border-t border-zinc-100 pt-3 dark:border-white/8">
                <FileText aria-hidden className="h-4 w-4 shrink-0" />
                {t("visual.artifact")}
              </p>
            </div>
          </div>
        </div>
      ),
    },
  ];

  return (
    <section
      id="how-it-works"
      className="border-t border-zinc-200 py-24 dark:border-white/[0.06]"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 max-w-xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            {t("eyebrow")}
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            {t("heading")}
          </h2>
        </div>

        <div className="space-y-16">
          {steps.map((step, i) => (
            <Reveal
              key={step.num}
              className={`grid items-center gap-10 md:grid-cols-2 ${
                i % 2 === 1 ? "md:[&>*:first-child]:order-2" : ""
              }`}
            >
              <div>
                <span className="text-5xl font-black text-zinc-200 dark:text-zinc-800">
                  {step.num}
                </span>
                <h3 className="mt-3 text-xl font-semibold text-zinc-900 dark:text-white">
                  {t(`steps.${step.key}.title`)}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {t(`steps.${step.key}.body`)}
                </p>
              </div>
              <div>{step.visual}</div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

function PricingSection({ authState }: { authState: LandingAuthState }) {
  const t = useTranslations("landing.pricing");
  const tp = useTranslations("pricing");
  const state = useDeploymentCapabilities();
  const plans = getPricingConfig();
  // Overlay localized display copy onto the canonical plans; prices, ids and CTA
  // hrefs stay untouched (the marketing-vs-canonical split, §20).
  const localizedPlans = plans.map((plan) => ({
    ...plan,
    name: tp(`plans.${plan.id}.name`),
    description: tp(`plans.${plan.id}.description`),
    cta: tp(`plans.${plan.id}.cta`),
    features: tp.raw(`plans.${plan.id}.features`) as string[],
  }));
  if (state.status !== "ready" || !state.capabilities.billing.checkout)
    return null;

  return (
    <section
      id="pricing"
      className="border-t border-zinc-200 py-24 dark:border-white/[0.06]"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-12 max-w-xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            {t("eyebrow")}
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            {t("heading")}
          </h2>
          <p className="mt-3 text-zinc-500 dark:text-zinc-400">{t("intro")}</p>
        </div>

        <PricingToggle authState={authState} plans={localizedPlans} />
      </div>
    </section>
  );
}

// ─── Page root ────────────────────────────────────────────────────────────────

export default function LandingV1({
  initialAuthState,
  marketStats,
}: {
  initialAuthState?: LandingAuthState;
  marketStats: ReactNode;
}) {
  const authState = useLandingAuthState(initialAuthState);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SourceWeftHeader authState={authState} />
      <main>
        <HeroSection authState={authState} marketStats={marketStats} />
        <SocialProof />
        <FeaturesSection />
        <HowItWorks />
        <PricingSection authState={authState} />
      </main>
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
