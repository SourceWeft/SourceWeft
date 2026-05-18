import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  FileText,
  Layers3,
  Quote,
  ScanSearch,
} from "lucide-react";

import type { BlogAccent, BlogVisualKind } from "./data";

const accentStyles: Record<
  BlogAccent,
  {
    bg: string;
    border: string;
    text: string;
    soft: string;
    glow: string;
    line: string;
  }
> = {
  amber: {
    bg: "bg-amber-400",
    border: "border-amber-300/60 dark:border-amber-300/35",
    glow: "from-amber-300/35",
    line: "bg-amber-400/70",
    soft: "bg-amber-100 text-amber-700 dark:bg-amber-300/12 dark:text-amber-200",
    text: "text-amber-600 dark:text-amber-200",
  },
  cyan: {
    bg: "bg-cyan-400",
    border: "border-cyan-300/60 dark:border-cyan-300/35",
    glow: "from-cyan-300/35",
    line: "bg-cyan-400/70",
    soft: "bg-cyan-100 text-cyan-700 dark:bg-cyan-300/12 dark:text-cyan-200",
    text: "text-cyan-600 dark:text-cyan-200",
  },
  emerald: {
    bg: "bg-emerald-400",
    border: "border-emerald-300/60 dark:border-emerald-300/35",
    glow: "from-emerald-300/35",
    line: "bg-emerald-400/70",
    soft:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-300/12 dark:text-emerald-200",
    text: "text-emerald-600 dark:text-emerald-200",
  },
  rose: {
    bg: "bg-rose-400",
    border: "border-rose-300/60 dark:border-rose-300/35",
    glow: "from-rose-300/35",
    line: "bg-rose-400/70",
    soft: "bg-rose-100 text-rose-700 dark:bg-rose-300/12 dark:text-rose-200",
    text: "text-rose-600 dark:text-rose-200",
  },
  violet: {
    bg: "bg-violet-400",
    border: "border-violet-300/60 dark:border-violet-300/35",
    glow: "from-violet-300/35",
    line: "bg-violet-400/70",
    soft:
      "bg-violet-100 text-violet-700 dark:bg-violet-300/12 dark:text-violet-200",
    text: "text-violet-600 dark:text-violet-200",
  },
};

function VisualShell({
  accent,
  children,
  compact = false,
}: {
  accent: BlogAccent;
  children: React.ReactNode;
  compact?: boolean;
}) {
  const styles = accentStyles[accent];

  return (
    <div
      className={`relative isolate overflow-hidden rounded-lg border ${styles.border} bg-zinc-50 text-zinc-950 shadow-[0_18px_60px_rgba(24,24,27,0.08)] dark:bg-zinc-950 dark:text-white dark:shadow-[0_18px_70px_rgba(0,0,0,0.35)] ${
        compact ? "min-h-48" : "min-h-[21rem]"
      }`}
    >
      <div
        aria-hidden
        className={`absolute inset-0 bg-[linear-gradient(rgba(24,24,27,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,24,27,0.055)_1px,transparent_1px)] bg-[size:28px_28px] opacity-70 dark:bg-[linear-gradient(rgba(255,255,255,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.055)_1px,transparent_1px)]`}
      />
      <div
        aria-hidden
        className={`absolute -top-20 right-0 h-56 w-56 rounded-full bg-gradient-to-br ${styles.glow} to-transparent blur-3xl`}
      />
      <div className={`relative h-full ${compact ? "p-5" : "p-7 md:p-8"}`}>
        {children}
      </div>
    </div>
  );
}

function CitationMap({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];
  const sources = ["notes/q4.pdf", "drive/metrics", "slack/retro"];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="flex items-center justify-between gap-4">
        <span className={`rounded-md px-2.5 py-1 text-xs font-semibold ${styles.soft}`}>
          grounded answer
        </span>
        <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-600">
          trace: 94%
        </span>
      </div>
      <div className="mt-8 grid gap-4 md:grid-cols-[1fr_0.72fr]">
        <div className="rounded-lg border border-zinc-200 bg-white/82 p-4 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <Quote className={`size-4 ${styles.text}`} />
            Answer draft
          </div>
          <div className="space-y-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            <p>
              Retention improved after onboarding changes, with the strongest
              signal in mobile sessions.
            </p>
            <p className="text-zinc-400 dark:text-zinc-500">
              The evidence is consistent across product notes and November
              metrics.
            </p>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {["1", "2", "3"].map((item) => (
              <span
                key={item}
                className="inline-flex size-7 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 font-mono text-xs dark:border-white/10 dark:bg-white/[0.04]"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="space-y-2.5">
          {sources.map((source, index) => (
            <div
              key={source}
              className="rounded-lg border border-zinc-200 bg-white/72 p-3 dark:border-white/10 dark:bg-white/[0.04]"
            >
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-zinc-400" />
                <span className="truncate text-xs font-medium">{source}</span>
                <CheckCircle2 className={`ml-auto size-4 ${styles.text}`} />
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                <div
                  className={`h-full ${styles.bg}`}
                  style={{ width: `${82 - index * 14}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </VisualShell>
  );
}

function CorpusGrid({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];
  const cells = ["PDF", "URL", "MD", "CSV", "TXT", "DOC"];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <Layers3 className={`size-4 ${styles.text}`} />
        Research corpus
      </div>
      <div className="mt-7 grid grid-cols-3 gap-3">
        {cells.map((cell, index) => (
          <div
            key={cell}
            className="rounded-lg border border-zinc-200 bg-white/80 p-3 dark:border-white/10 dark:bg-white/[0.04]"
          >
            <div className={`mb-8 h-1.5 w-8 rounded-full ${index % 2 ? "bg-zinc-300 dark:bg-zinc-700" : styles.bg}`} />
            <p className="font-mono text-xs text-zinc-500">{cell}</p>
            <div className="mt-2 space-y-1.5">
              <span className="block h-1.5 rounded bg-zinc-200 dark:bg-white/12" />
              <span className="block h-1.5 w-2/3 rounded bg-zinc-200 dark:bg-white/12" />
            </div>
          </div>
        ))}
      </div>
      {!compact ? (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 dark:text-zinc-400">semantic coverage</span>
            <span className={styles.text}>ready</span>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-zinc-100 dark:bg-white/10">
            <div className={`h-full w-[76%] rounded-full ${styles.bg}`} />
          </div>
        </div>
      ) : null}
    </VisualShell>
  );
}

function TeamStream({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];
  const items = ["Slack decision", "Drive brief", "Notebook answer"];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="flex items-center justify-between text-xs">
        <span className={`rounded-md px-2.5 py-1 font-semibold ${styles.soft}`}>
          team stream
        </span>
        <span className="text-zinc-400">live sync</span>
      </div>
      <div className="mt-9 space-y-4">
        {items.map((item, index) => (
          <div key={item} className="flex items-center gap-3">
            <span className={`flex size-9 items-center justify-center rounded-lg border ${styles.border} bg-white dark:bg-white/[0.04]`}>
              {index === 2 ? (
                <CheckCircle2 className={`size-4 ${styles.text}`} />
              ) : (
                <CircleDot className="size-4 text-zinc-400" />
              )}
            </span>
            <div className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white/78 p-3 dark:border-white/10 dark:bg-white/[0.04]">
              <p className="truncate text-sm font-medium">{item}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {index === 0 ? "#research-ops" : index === 1 ? "/Q2 planning" : "cited summary"}
              </p>
            </div>
            {index < items.length - 1 ? (
              <ArrowRight className="hidden size-4 text-zinc-300 sm:block" />
            ) : null}
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

function EvalBoard({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];
  const metrics = [
    ["grounding", "91"],
    ["latency", "1.8s"],
    ["cost", "$0.04"],
  ];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="grid grid-cols-3 gap-2">
        {metrics.map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-zinc-200 bg-white/75 p-3 dark:border-white/10 dark:bg-white/[0.04]"
          >
            <p className="text-[10px] uppercase text-zinc-400">{label}</p>
            <p className="mt-2 font-mono text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-7 rounded-lg border border-zinc-200 bg-white/75 p-4 dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between text-xs">
          <span>golden set</span>
          <span className={styles.text}>pass</span>
        </div>
        <div className="mt-5 space-y-3">
          {[88, 72, 96, 64].map((width, index) => (
            <div key={width} className="flex items-center gap-3">
              <span className="font-mono text-[10px] text-zinc-400">
                T{index + 1}
              </span>
              <span className="h-1.5 flex-1 rounded-full bg-zinc-100 dark:bg-white/10">
                <span
                  className={`block h-full rounded-full ${index === 1 ? "bg-zinc-300 dark:bg-zinc-700" : styles.bg}`}
                  style={{ width: `${width}%` }}
                />
              </span>
            </div>
          ))}
        </div>
      </div>
    </VisualShell>
  );
}

function IngestionStack({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];
  const layers = ["parse", "chunk", "embed", "cite"];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="mx-auto max-w-sm space-y-3 pt-2">
        {layers.map((layer, index) => (
          <div
            key={layer}
            className="rounded-lg border border-zinc-200 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"
            style={{ transform: `translateX(${(index - 1.5) * 10}px)` }}
          >
            <div className="flex items-center gap-3">
              <span className={`h-8 w-1.5 rounded-full ${index === layers.length - 1 ? styles.bg : "bg-zinc-300 dark:bg-zinc-700"}`} />
              <div>
                <p className="text-sm font-semibold">{layer}</p>
                <p className="text-xs text-zinc-400">pipeline stage {index + 1}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

function MemoryIndex({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="grid gap-4 sm:grid-cols-[0.85fr_1fr]">
        <div className="rounded-lg border border-zinc-200 bg-white/75 p-4 dark:border-white/10 dark:bg-white/[0.04]">
          <p className="text-xs font-semibold text-zinc-500">memory scopes</p>
          <div className="mt-5 space-y-3">
            {["chat", "project", "team"].map((scope, index) => (
              <div key={scope} className="flex items-center gap-2 text-sm">
                <span className={`size-2 rounded-full ${index === 1 ? styles.bg : "bg-zinc-300 dark:bg-zinc-700"}`} />
                {scope}
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white/75 p-4 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center gap-2">
            <ScanSearch className={`size-4 ${styles.text}`} />
            <p className="text-sm font-medium">visible influence</p>
          </div>
          <div className="mt-5 space-y-2">
            <span className="block h-2 rounded-full bg-zinc-200 dark:bg-white/12" />
            <span className="block h-2 w-4/5 rounded-full bg-zinc-200 dark:bg-white/12" />
            <span className={`block h-2 w-1/2 rounded-full ${styles.bg}`} />
          </div>
        </div>
      </div>
    </VisualShell>
  );
}

function PrivateEval({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="rounded-lg border border-zinc-200 bg-white/78 p-4 dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">private eval run</p>
          <span className={`rounded-md px-2 py-1 text-[11px] ${styles.soft}`}>
            sealed
          </span>
        </div>
        <div className="mt-6 grid grid-cols-4 gap-2">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
            <span
              key={item}
              className={`h-12 rounded-md border ${
                item % 3 === 0
                  ? `${styles.border} ${styles.bg}/20`
                  : "border-zinc-200 bg-zinc-100 dark:border-white/10 dark:bg-white/8"
              }`}
            />
          ))}
        </div>
      </div>
      <div className="mt-5 flex items-center gap-3 rounded-lg border border-zinc-200 bg-white/72 p-3 text-xs dark:border-white/10 dark:bg-white/[0.04]">
        <CheckCircle2 className={`size-4 ${styles.text}`} />
        Evidence stays inside workspace boundary
      </div>
    </VisualShell>
  );
}

function AgentTrail({ accent, compact }: { accent: BlogAccent; compact?: boolean }) {
  const styles = accentStyles[accent];
  const steps = ["search", "inspect", "compare", "brief"];

  return (
    <VisualShell accent={accent} compact={compact}>
      <div className="relative mt-4 space-y-4">
        <span className={`absolute left-4 top-4 h-[calc(100%-2rem)] w-px ${styles.line}`} />
        {steps.map((step, index) => (
          <div key={step} className="relative flex items-center gap-4">
            <span className={`z-10 flex size-8 items-center justify-center rounded-full border ${styles.border} bg-white dark:bg-zinc-950`}>
              <span className={`size-2 rounded-full ${index === steps.length - 1 ? styles.bg : "bg-zinc-300 dark:bg-zinc-700"}`} />
            </span>
            <div className="flex-1 rounded-lg border border-zinc-200 bg-white/75 p-3 dark:border-white/10 dark:bg-white/[0.04]">
              <p className="text-sm font-medium">{step}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {index + 2} artifacts preserved
              </p>
            </div>
          </div>
        ))}
      </div>
    </VisualShell>
  );
}

export function BlogVisual({
  accent,
  compact = false,
  visual,
}: {
  accent: BlogAccent;
  compact?: boolean;
  visual: BlogVisualKind;
}) {
  if (visual === "corpus-grid") {
    return <CorpusGrid accent={accent} compact={compact} />;
  }

  if (visual === "team-stream") {
    return <TeamStream accent={accent} compact={compact} />;
  }

  if (visual === "eval-board") {
    return <EvalBoard accent={accent} compact={compact} />;
  }

  if (visual === "ingestion-stack") {
    return <IngestionStack accent={accent} compact={compact} />;
  }

  if (visual === "memory-index") {
    return <MemoryIndex accent={accent} compact={compact} />;
  }

  if (visual === "private-eval") {
    return <PrivateEval accent={accent} compact={compact} />;
  }

  if (visual === "agent-trail") {
    return <AgentTrail accent={accent} compact={compact} />;
  }

  return <CitationMap accent={accent} compact={compact} />;
}
