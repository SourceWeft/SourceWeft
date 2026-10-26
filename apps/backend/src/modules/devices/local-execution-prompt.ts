import {
  DEVICE_ARCHES,
  DEVICE_PLATFORMS,
  DEVICE_SHELL_PATTERN,
} from "./invocation-reply";

/**
 * The `local_devices` columns the runtime prompt may draw on. Everything is
 * nullable because hosts that predate the `status` report never fill them.
 *
 * `sandbox_reason` and `capabilities` are deliberately absent: they are free
 * text written by the device, so they must never reach a model prompt.
 */
export interface LocalExecutionDevice {
  platform: string | null;
  arch: string | null;
  shell: string | null;
  sandboxState: string | null;
}

const OS_LABEL = { macos: "macOS", linux: "Linux" } as const;

const LINUX_SANDBOX_RULES = [
  "Commands run with these restrictions on this computer:",
  "- Writes are possible only inside the working folder.",
  "- The home directory and most of the filesystem cannot be read, except the working folder, system directories and the user's toolchains; directories that are denied may look empty.",
  "- Network access allows the public internet only; private, loopback and metadata addresses are refused.",
  "- Blocked actions are reported in a <sandbox_violations> block in the tool result. Read it and change your approach instead of retrying the same action.",
  "- Protected files cannot be written: .git/hooks, shell rc files, .vscode, .idea and .mcp.json.",
  "- When initialising a repository use an empty template: git init --template=",
  "- Node's built-in fetch needs NODE_USE_ENV_PROXY=1, which is already set.",
];

const NEEDS_SETUP_SENTENCE =
  "Local command execution is currently unavailable on this computer until its owner finishes setup.";

function pick<T extends string>(
  allowed: readonly T[],
  value: string | null,
): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

/**
 * Factual environment lines for the `<local_execution_presentation>` block,
 * or "" when the device has told us nothing usable (old host, unknown or
 * unsupported platform). Values are re-validated here even though the status
 * report is validated on the way in, so the prompt never depends on what a
 * stored row happens to contain.
 */
export function localExecutionEnvironmentPrompt(
  device: LocalExecutionDevice | null,
): string {
  if (!device) return "";
  const platform = pick(DEVICE_PLATFORMS, device.platform);
  const osLabel =
    platform === "macos" || platform === "linux" ? OS_LABEL[platform] : null;
  const lines: string[] = [];
  if (osLabel) {
    const arch = pick(DEVICE_ARCHES, device.arch);
    lines.push(`Operating system: ${osLabel}${arch ? ` (${arch})` : ""}`);
    if (device.shell && DEVICE_SHELL_PATTERN.test(device.shell))
      lines.push(`Shell: ${device.shell} (commands run under this shell)`);
    lines.push(
      "Paths are POSIX-style: forward slashes, and absolute paths start with /.",
    );
  }
  if (device.sandboxState === "needsSetup") {
    lines.push(NEEDS_SETUP_SENTENCE);
  } else if (platform === "linux" && device.sandboxState !== "unsupported") {
    lines.push(...LINUX_SANDBOX_RULES);
  }
  return lines.join("\n");
}
