import type {
  SandboxReadiness,
  SandboxRemedy,
  SandboxSetupCode,
} from "./desktop-bridge";

/** What the "Set up local execution" card offers for a readiness report. */
export type SandboxSetupAction =
  "install" | "updateApp" | "reinstallPackage" | "privilegedSetup" | "none";

export type SandboxSetupCard = {
  code: SandboxSetupCode;
  /** The host's own explanation, shown verbatim. */
  reason: string;
  action: SandboxSetupAction;
  /** True while an install is already running (started from any window). */
  installing: boolean;
  /** Exact command to run in a terminal; only for `privilegedSetup`. */
  setupCommand: string | null;
};

const ACTION_BY_REMEDY: Record<SandboxRemedy, SandboxSetupAction> = {
  downloadRuntime: "install",
  updateApp: "updateApp",
  reinstallPackage: "reinstallPackage",
  privilegedSetup: "privilegedSetup",
  none: "none",
};

/**
 * Maps the host's readiness onto the setup card. Returns null unless setup is needed, so
 * `ready`, `unsupported` and the absent readiness (macOS, older builds) show no card.
 * An unknown remedy from a newer host degrades to reason-only rather than guessing an action.
 */
export function sandboxSetupCard(
  readiness: SandboxReadiness | null | undefined,
): SandboxSetupCard | null {
  if (!readiness || readiness.state !== "needsSetup") return null;
  const action = ACTION_BY_REMEDY[readiness.remedy] ?? "none";
  const setupCommand =
    action === "privilegedSetup" && readiness.setupCommand
      ? readiness.setupCommand
      : null;
  return {
    code: readiness.code,
    reason: readiness.reason,
    action,
    installing: readiness.code === "installing",
    setupCommand,
  };
}

const PLATFORM_LABELS: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

/** "Linux x64" from a device report; null when the device did not report a platform. */
export function deviceSystemLabel(device: {
  platform?: string | null;
  arch?: string | null;
}): string | null {
  if (!device.platform) return null;
  const name = PLATFORM_LABELS[device.platform] ?? device.platform;
  return device.arch ? `${name} ${device.arch}` : name;
}
