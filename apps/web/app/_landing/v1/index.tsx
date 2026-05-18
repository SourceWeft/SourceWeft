"use client";

import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { SourceWeftFooter } from "../components/sourceweft-footer";
import { SourceWeftHeader } from "../components/sourceweft-header";
import { SourceWeftBrandMark } from "../components/sourceweft-brand";
import {
  type LandingAuthState,
  useLandingAuthState,
} from "../components/use-landing-auth-state";
import { getPricingConfig } from "../pricing-config";
import { PricingToggle } from "./pricing-toggle";

// ─── tiny SVG icons (inline, no external dep) ────────────────────────────────

function IconBrain() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M9.5 2a4.5 4.5 0 0 1 4.5 4.5v.086A4.5 4.5 0 0 1 17.5 11c0 .17-.01.339-.028.504A4 4 0 0 1 20 15.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4 4 4 0 0 1 2.528-3.696A4.5 4.5 0 0 1 6 10.5a4.5 4.5 0 0 1 3.5-4.414V2Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function IconDatabase() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <ellipse
        cx="12"
        cy="5"
        rx="8"
        ry="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4 5v5c0 1.657 3.582 3 8 3s8-1.343 8-3V5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4 10v5c0 1.657 3.582 3 8 3s8-1.343 8-3v-5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 2L2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function IconArrow() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 16 16">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 16 16">
      <path
        d="M3 8l3.5 3.5L13 4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function HeroSection({ authState }: { authState: LandingAuthState }) {
  const primaryHref = authState.isSignedIn ? "/dashboard" : "/auth/sign-in";
  const primaryLabel = authState.isSignedIn
    ? "Open Dashboard"
    : "Start for free";

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
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/5 dark:text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Now in early access
            </div>

            <h1 className="text-4xl font-bold tracking-tight text-zinc-900 md:text-5xl lg:text-[3.5rem] lg:leading-[1.1] dark:text-white">
              Your AI Notebook
              <br />
              <span className="text-zinc-400 dark:text-zinc-400">
                Workspace.
              </span>
            </h1>

            <p className="mt-5 max-w-md text-base leading-relaxed text-zinc-500 md:text-lg dark:text-zinc-400">
              Upload sources, connect Notion, Google Drive, Gmail, Slack and
              more. Generate source-grounded answers with citations, audio
              overviews, study guides, FAQs, and deep AI insights from your own
              content.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={primaryHref}
                className={
                  authState.isSignedIn
                    ? "inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
                    : "inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                }
              >
                {authState.isSignedIn ? (
                  <LayoutDashboard className="size-4" />
                ) : null}
                {primaryLabel}
                {authState.isSignedIn ? null : <IconArrow />}
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-5 py-2.5 text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-white/16 dark:text-white dark:hover:border-white/30 dark:hover:bg-white/5"
              >
                See how it works
              </a>
            </div>

            {/* Stats */}
            <div className="mt-10 flex flex-wrap gap-6 border-t border-zinc-200 pt-8 dark:border-white/8">
              {[
                ["10+", "LLM providers"],
                ["5+", "output formats"],
                ["10+", "integrations"],
              ].map(([num, label]) => (
                <div key={label}>
                  <p className="text-xl font-bold text-zinc-900 dark:text-white">
                    {num}
                  </p>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Right — mock UI */}
          <div className="relative">
            <div
              className="relative rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-zinc-900/80"
              style={{ backdropFilter: "blur(8px)" }}
            >
              {/* Window chrome */}
              <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-white/8">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                <span className="ml-3 text-xs text-zinc-400 dark:text-zinc-600">
                  SourceWeft — Research workspace
                </span>
              </div>

              {/* Chat messages */}
              <div className="space-y-4 p-5">
                {/* User message */}
                <div className="flex justify-end">
                  <div className="max-w-[75%] rounded-xl rounded-tr-sm bg-zinc-100 px-4 py-2.5 text-sm text-zinc-800 dark:bg-zinc-700/80 dark:text-zinc-100">
                    Summarise the key findings from my Q4 research notes
                  </div>
                </div>

                {/* AI reply */}
                <div className="flex gap-3">
                  <SourceWeftBrandMark className="mt-0.5 h-6 w-6 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="rounded-xl rounded-tl-sm border border-zinc-100 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 leading-relaxed dark:border-white/8 dark:bg-zinc-800/60 dark:text-zinc-200">
                      Based on your Q4 research notes, here are the key
                      findings:
                      <ol className="mt-2 space-y-1.5 pl-4 text-zinc-600 dark:text-zinc-300">
                        <li className="list-decimal">
                          User retention increased 23% after onboarding revamp
                        </li>
                        <li className="list-decimal">
                          Mobile sessions now account for 61% of total traffic
                        </li>
                        <li className="list-decimal">
                          Search latency reduced to under 120 ms p95
                        </li>
                      </ol>
                    </div>

                    {/* Source citations + connector to badge */}
                    <div className="relative flex w-fit flex-wrap gap-1.5">
                      {["Q4-notes.pdf", "retro-oct.md", "metrics-nov.csv"].map(
                        (src) => (
                          <span
                            key={src}
                            className="relative z-10 inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-400 dark:border-white/8 dark:bg-zinc-800/60 dark:text-zinc-500"
                          >
                            <svg
                              className="h-3 w-3"
                              fill="none"
                              viewBox="0 0 12 12"
                            >
                              <path
                                d="M2 2h5l3 3v5H2V2Z"
                                stroke="currentColor"
                                strokeWidth="1"
                              />
                              <path
                                d="M7 2v3h3"
                                stroke="currentColor"
                                strokeWidth="1"
                              />
                            </svg>
                            {src}
                          </span>
                        ),
                      )}

                      {/*
                        Z-shaped connector (Step-down pattern):
                        1. Bottom line: Starts at chip right edge (right:0), extends RIGHT by 40px.
                        2. Vertical line: Positioned 40px to the right of chips (right:-40px).
                        3. Top line: From vertical pivot (right:-40px), extends RIGHT to badge.
                      */}

                      {/* Segment 1: bottom horizontal — extending RIGHT from the chip edge */}
                      <div
                        className="pointer-events-none absolute hidden md:block"
                        style={{
                          right: "-40px",
                          top: "50%",
                          width: "40px",
                          height: "1px",
                          backgroundImage:
                            "repeating-linear-gradient(to right, #a1a1aa 0px, #a1a1aa 4px, transparent 4px, transparent 8px)",
                        }}
                      />
                      {/* Segment 2: vertical — moved 40px to the right of the chips, going up */}
                      <div
                        className="pointer-events-none absolute hidden md:block"
                        style={{
                          right: "-40px",
                          top: "calc(50% - 124px)",
                          width: "1px",
                          height: "124px",
                          backgroundImage:
                            "repeating-linear-gradient(to bottom, #a1a1aa 0px, #a1a1aa 4px, transparent 4px, transparent 8px)",
                        }}
                      />
                      {/* Segment 3: top horizontal — from vertical pivot (right:-40px) to badge (right:-240px) */}
                      <div
                        className="pointer-events-none absolute hidden md:block"
                        style={{
                          right: "-240px",
                          top: "calc(50% - 124px)",
                          width: "200px",
                          height: "1px",
                          backgroundImage:
                            "repeating-linear-gradient(to right, #a1a1aa 0px, #a1a1aa 4px, transparent 4px, transparent 8px)",
                        }}
                      />
                      {/* Badge — positioned relative to the right edge of the chips */}
                      <div
                        className="pointer-events-none absolute hidden md:block"
                        style={{
                          right: "-240px",
                          top: "calc(50% - 152px)",
                        }}
                      >
                        <div className="w-32 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 shadow-lg dark:border-white/10 dark:bg-zinc-900">
                          <p className="text-xs font-semibold text-zinc-900 dark:text-white">
                            3 sources cited
                          </p>
                          <p className="mt-0.5 text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
                            Grounded in your documents
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Typing indicator */}
                <div className="flex gap-3">
                  <SourceWeftBrandMark className="mt-0.5 h-6 w-6 rounded-full" />
                  <div className="flex items-center gap-1.5 rounded-xl rounded-tl-sm border border-zinc-100 bg-zinc-50 px-4 py-3 dark:border-white/8 dark:bg-zinc-800/60">
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-500"
                      style={{
                        animation: "blink 1.2s ease-in-out 0s infinite",
                      }}
                    />
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-500"
                      style={{
                        animation: "blink 1.2s ease-in-out 0.2s infinite",
                      }}
                    />
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-500"
                      style={{
                        animation: "blink 1.2s ease-in-out 0.4s infinite",
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Input bar */}
              <div className="border-t border-zinc-100 px-4 py-3 dark:border-white/8">
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-white/10 dark:bg-zinc-800/60">
                  <span className="flex-1 text-sm text-zinc-400 dark:text-zinc-600">
                    Ask anything about your knowledge base…
                  </span>
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                    <IconArrow />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Social proof strip ───────────────────────────────────────────────────────

function SocialProof() {
  return (
    <section className="border-y border-zinc-200 py-10 dark:border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6">
        <p className="mb-8 text-center text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
          For researchers, students, and creators who go deep
        </p>
        <div className="flex flex-wrap justify-center gap-x-12 gap-y-6">
          {[
            ["Researchers", "who need to trust their sources"],
            ["Writers", "who connect ideas across notes"],
            ["Developers", "who live in docs and RFCs"],
            ["Students", "who want to learn, not just read"],
          ].map(([role, desc]) => (
            <div key={role} className="text-center">
              <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                {role}
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-600">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Features ─────────────────────────────────────────────────────────────────

function FeaturesSection() {
  const features = [
    {
      icon: <IconBrain />,
      title: "Multiple outputs from your sources",
      description:
        "Ask questions, or generate an audio overview, study guide, FAQ, briefing doc, or timeline — all grounded in your uploaded sources, with inline citations.",
      bullets: [
        "Audio overviews & podcasts",
        "Study guides, FAQs & timelines",
        "Inline source citations",
      ],
    },
    {
      icon: <IconDatabase />,
      title: "Connect everything",
      description:
        "Don't just upload files — connect Notion, Google Drive, Gmail, Slack, and more. SourceWeft indexes your existing tools so your knowledge is always at hand.",
      bullets: [
        "Notion, Google Drive, Gmail, Slack",
        "25+ file formats supported",
        "Browser extension for instant capture",
      ],
    },
    {
      icon: <IconLayers />,
      title: "Works everywhere you do",
      description:
        "Web app, desktop, and browser extension — all in sync. Capture a page anywhere, continue the conversation on any device. Your notebook travels with you.",
      bullets: [
        "macOS & Windows desktop",
        "Chrome & Edge extension",
        "Mobile app (coming soon)",
      ],
    },
  ];

  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-14 max-w-xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            Features
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            Everything your AI knowledge workspace needs
          </h2>
          <p className="mt-3 text-zinc-500 dark:text-zinc-400">
            Upload sources. Connect your tools. Get answers, audio overviews,
            study guides and more — all grounded in what you know, with
            citations you can inspect.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border border-zinc-200 bg-zinc-50 p-6 transition-all duration-200 hover:-translate-y-1 hover:border-zinc-300 hover:bg-white hover:shadow-sm dark:border-white/8 dark:bg-zinc-900/40 dark:hover:border-white/16 dark:hover:bg-zinc-900/60"
            >
              <div className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-300">
                {f.icon}
              </div>
              <h3 className="mb-2 text-base font-semibold text-zinc-900 dark:text-white">
                {f.title}
              </h3>
              <p className="mb-4 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                {f.description}
              </p>
              <ul className="space-y-1.5">
                {f.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500"
                  >
                    <IconCheck />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── How it works ─────────────────────────────────────────────────────────────

function HowItWorks() {
  const steps = [
    {
      num: "01",
      title: "Create your workspace",
      body: "Set up a personal or team workspace in seconds. Organise knowledge into spaces — one for each project, topic, or area of your life.",
      visual: (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs dark:border-white/8 dark:bg-zinc-900/60">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-zinc-500 dark:text-zinc-400">
              New workspace
            </span>
          </div>
          <div className="space-y-2">
            {["Research 2025", "Product docs", "Weekly reading"].map((ws) => (
              <div
                key={ws}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-zinc-700 dark:border-white/6 dark:bg-zinc-800/60 dark:text-zinc-300"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zinc-100 text-[10px] font-bold text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                  {ws[0]}
                </span>
                {ws}
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      num: "02",
      title: "Connect your knowledge sources",
      body: "Connect Notion, Google Drive, Gmail, or Slack — or drop in PDFs, paste URLs, and capture any web page. SourceWeft indexes everything, wherever your knowledge lives.",
      visual: (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs dark:border-white/8 dark:bg-zinc-900/60">
          <p className="mb-3 text-zinc-400 dark:text-zinc-500">Sources added</p>
          <div className="space-y-2">
            {[
              {
                name: "thesis-draft.pdf",
                type: "PDF",
                color:
                  "bg-red-100 text-red-500 dark:bg-red-500/20 dark:text-red-400",
              },
              {
                name: "arxiv.org/abs/2401...",
                type: "URL",
                color:
                  "bg-blue-100 text-blue-500 dark:bg-blue-500/20 dark:text-blue-400",
              },
              {
                name: "meeting-notes.md",
                type: "MD",
                color:
                  "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400",
              },
            ].map((src) => (
              <div
                key={src.name}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-white/6 dark:bg-zinc-800/60"
              >
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${src.color}`}
                >
                  {src.type}
                </span>
                <span className="truncate text-zinc-600 dark:text-zinc-300">
                  {src.name}
                </span>
                <span className="ml-auto text-emerald-500">
                  <IconCheck />
                </span>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      num: "03",
      title: "Chat with your AI",
      body: "Ask questions, get summaries, explore connections. Every answer is grounded in your own sources with inline citations you can inspect.",
      visual: (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs dark:border-white/8 dark:bg-zinc-900/60">
          <div className="mb-2 flex justify-end">
            <div className="max-w-[80%] rounded-lg rounded-tr-sm bg-zinc-100 px-3 py-2 text-zinc-800 dark:bg-zinc-700/80 dark:text-zinc-100">
              What did I learn about attention mechanisms?
            </div>
          </div>
          <div className="flex gap-2">
            <SourceWeftBrandMark className="mt-0.5 h-5 w-5 rounded-full" />
            <div className="rounded-lg rounded-tl-sm border border-zinc-100 bg-white px-3 py-2 text-zinc-700 leading-relaxed dark:border-white/8 dark:bg-zinc-800/60 dark:text-zinc-200">
              From your thesis draft: attention is a mechanism that allows
              models to focus on relevant parts of the input…{" "}
              <span className="rounded border border-zinc-200 bg-zinc-100 px-1 text-zinc-400 dark:border-white/8 dark:bg-zinc-700/60 dark:text-zinc-500">
                thesis-draft.pdf p.12
              </span>
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
            How it works
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            From zero to AI-powered in minutes
          </h2>
        </div>

        <div className="space-y-16">
          {steps.map((step, i) => (
            <div
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
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {step.body}
                </p>
              </div>
              <div>{step.visual}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

function PricingSection({ authState }: { authState: LandingAuthState }) {
  const plans = getPricingConfig();

  return (
    <section
      id="pricing"
      className="border-t border-zinc-200 py-24 dark:border-white/[0.06]"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-12 max-w-xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
            Pricing
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            Simple, transparent pricing
          </h2>
          <p className="mt-3 text-zinc-500 dark:text-zinc-400">
            Start free. Upgrade when you need more. No surprise bills.
          </p>
        </div>

        <PricingToggle authState={authState} plans={plans} />
      </div>
    </section>
  );
}

// ─── Keyframe styles (injected via style tag) ────────────────────────────────

function GlobalStyles() {
  return (
    <style>{`
      @keyframes blink {
        0%, 100% { opacity: 0.3; }
        50% { opacity: 1; }
      }
    `}</style>
  );
}

// ─── Page root ────────────────────────────────────────────────────────────────

export default function LandingV1({
  initialAuthState,
}: {
  initialAuthState?: LandingAuthState;
}) {
  const authState = useLandingAuthState(initialAuthState);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <GlobalStyles />
      <SourceWeftHeader authState={authState} />
      <HeroSection authState={authState} />
      <SocialProof />
      <FeaturesSection />
      <HowItWorks />
      <PricingSection authState={authState} />
      <SourceWeftFooter authState={authState} />
    </div>
  );
}
