"use client";

import { useId, useState } from "react";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { CopyButton } from "../../mcp/_components/mcp-client";

type InstallOption = "agent" | "terminal";

/**
 * The two ways onto an agent of one's own, under the page's "Add to
 * SourceWeft": a prompt to paste into the agent — it reads the skill's install
 * guide and runs the CLI — or the CLI command to run yourself. The prompt comes
 * first because it also works in SourceWeft chat. Strings arrive translated
 * from the server page.
 */
export function SkillInstallOptions({
  agentPrompt,
  cliCommand,
  labels,
}: {
  agentPrompt: string;
  cliCommand: string;
  labels: {
    heading: string;
    tabsLabel: string;
    agent: string;
    terminal: string;
    agentLead: string;
    terminalLead: string;
    copy: string;
  };
}) {
  const [selected, setSelected] = useState<InstallOption>("agent");
  const id = useId();
  const options: [InstallOption, string][] = [
    ["agent", labels.agent],
    ["terminal", labels.terminal],
  ];
  const value = selected === "agent" ? agentPrompt : cliCommand;
  return (
    <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {labels.heading}
        </p>
        <div
          aria-label={labels.tabsLabel}
          className="inline-flex rounded-lg border border-zinc-300 p-0.5 text-xs dark:border-white/10"
          role="tablist"
        >
          {options.map(([option, label]) => (
            <button
              aria-controls={`${id}-panel`}
              aria-selected={option === selected}
              className={cn(
                "rounded-md px-2.5 py-1",
                option === selected
                  ? "bg-zinc-950 font-medium text-white dark:bg-white dark:text-zinc-950"
                  : "text-zinc-500 transition-colors hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white",
              )}
              id={`${id}-${option}`}
              key={option}
              onClick={() => setSelected(option)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        aria-labelledby={`${id}-${selected}`}
        className="mt-3"
        id={`${id}-panel`}
        role="tabpanel"
      >
        {/* The prompt is prose for a person to read before pasting; the command stays code. */}
        <p
          className={cn(
            "rounded-lg bg-zinc-100 px-3 py-2 text-xs leading-5 text-zinc-800 dark:bg-white/10 dark:text-zinc-200",
            selected === "agent" ? "break-words" : "break-all font-mono",
          )}
        >
          {value}
        </p>
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {selected === "agent" ? labels.agentLead : labels.terminalLead}
          </p>
          <CopyButton
            className="h-7 shrink-0 px-2"
            label={labels.copy}
            value={value}
          />
        </div>
      </div>
    </div>
  );
}
