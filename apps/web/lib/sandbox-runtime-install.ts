"use client";

import { useSyncExternalStore } from "react";
import { desktopBridge, type SandboxReadiness } from "./desktop-bridge";
import { isSandboxProbePending } from "./sandbox-setup";

/**
 * The sandbox runtime install as this page knows it. `finished` counts the installs that
 * completed since the page loaded: a change means the host status is worth reading again.
 * A finished install is not a ready computer; the host may still ask for another setup step.
 */
export type SandboxInstallState = {
  phase: "idle" | "installing" | "failed";
  /** The host's own code and reason for the last failed install. */
  error: string | null;
  finished: number;
  /** What the host reported when the last finished install ended. */
  readiness: SandboxReadiness | null;
};

const IDLE: SandboxInstallState = {
  phase: "idle",
  error: null,
  finished: 0,
  readiness: null,
};

let state = IDLE;
let pending: Promise<SandboxReadiness> | null = null;
let automaticAttempted = false;
let automaticCheck: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: SandboxInstallState) {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Downloads, verifies and installs the sandbox runtime. Every caller on the page goes through
 * here, so the automatic install, the Settings button and a retry share one run: a call made
 * while an install is running joins it instead of starting a second one.
 */
export function installSandboxRuntime(): Promise<SandboxReadiness> {
  if (pending) return pending;
  publish({ ...state, phase: "installing", error: null });
  const attempt = desktopBridge.installSandboxRuntime();
  pending = attempt;
  void attempt.then(
    (readiness) => {
      if (pending !== attempt) return;
      pending = null;
      publish({
        phase: "idle",
        error: null,
        finished: state.finished + 1,
        readiness,
      });
    },
    (error: unknown) => {
      if (pending !== attempt) return;
      pending = null;
      publish({
        ...state,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  return attempt;
}

/**
 * Installs the runtime without being asked, when the only thing this computer is missing is
 * the runtime download (`downloadRuntime`: not installed, out of date or damaged), or when it
 * works but was installed by an older app version (`runtime.updateAvailable`). Every other
 * remedy needs the user and is left to Settings, and an install that is already running is
 * left alone. At most one install is started this way per page load; a failure stays in the
 * state for the user to retry and nothing here tries again.
 */
export function installSandboxRuntimeAutomatically(): Promise<void> {
  if (automaticAttempted || !desktopBridge.isAvailable())
    return Promise.resolve();
  // Overlapping calls (the dashboard effect runs again) share one check.
  automaticCheck ??= (async () => {
    try {
      const { readiness, runtime } = await settledStatus();
      // A working runtime from an older app version is refreshed too; if that fails the old
      // one keeps working and the failure is left in the state.
      const outdated =
        readiness?.state === "ready" && runtime?.updateAvailable === true;
      const missing =
        readiness?.state === "needsSetup" &&
        readiness.remedy === "downloadRuntime" &&
        readiness.code !== "installing";
      if (!outdated && !missing) return;
      automaticAttempted = true;
      // The failure is kept in the state; there is nobody here to report it to.
      await installSandboxRuntime().catch(() => {});
    } catch {
      // The host status could not be read: nothing is known, so nothing is installed.
    } finally {
      automaticCheck = null;
    }
  })();
  return automaticCheck;
}

const SETTLE_READS = 20;
const SETTLE_DELAY_MS = 500;

/**
 * The host's readiness once its own probe has answered. When the app opens, several readers
 * ask at once and all but one get a placeholder while the probe runs; acting on that would
 * skip the install for the whole page load. Reads again for at most ten seconds, then
 * returns whatever the host says. This waits for a status, it never repeats an install.
 */
async function settledStatus() {
  for (let read = 1; ; read += 1) {
    const status = await desktopBridge.localHostStatus();
    if (!isSandboxProbePending(status.readiness) || read >= SETTLE_READS)
      return status;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSandboxInstallState() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => IDLE,
  );
}

/** Forgets everything, as a page load does. For tests. */
export function resetSandboxInstall() {
  pending = null;
  automaticAttempted = false;
  automaticCheck = null;
  publish(IDLE);
}
