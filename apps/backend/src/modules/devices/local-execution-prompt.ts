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

const OS_LABEL = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
} as const;

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

const WINDOWS_PATH_LINE =
  "Paths are forward-slash drive paths (for example C:/Users/name/project): use forward slashes, never backslashes, and absolute paths start with a drive letter and a slash.";

const WINDOWS_SANDBOX_RULES = [
  "Commands run with these restrictions on this computer:",
  "- Commands run as a separate sandbox account, not as the signed-in user.",
  "- Writes are possible only inside the working folder.",
  "- The user's profile and most of the filesystem cannot be read, except the working folder, system directories and the user's toolchains.",
  "- Network access allows the public internet only; private, loopback and metadata addresses are refused.",
  "- Programs built on the Windows Schannel TLS stack cannot do HTTPS under the sandbox: curl and curl.exe (including the curl that ships with Git Bash), PowerShell Invoke-WebRequest and Invoke-RestMethod, .NET HttpClient, winget and cargo's HTTPS downloads all fail. For network access use Node's built-in fetch, Python, git, or Java and Go programs.",
  "- Blocked actions are reported in a <sandbox_violations> block in the tool result. Read it and change your approach instead of retrying the same action.",
  "- Node's built-in fetch needs NODE_USE_ENV_PROXY=1, which is already set.",
];

const WINDOWS_GIT_BASH_RULES = [
  "- Git Bash shell: use POSIX-style quoting and POSIX commands; paths such as C:/Users/name/project work as they are. Plain `curl` fails here too, because Git for Windows builds it on Schannel; use Node, Python or git instead.",
];

const WINDOWS_POWERSHELL_RULES = [
  "- Windows PowerShell 5.1 shell: use single quotes for literal strings, `;` instead of `&&` to chain commands, and the PowerShell cmdlets rather than POSIX tools. Do not use curl or wget, which are Invoke-WebRequest aliases that cannot reach the network here, and curl.exe fails as well.",
];

function windowsShellKind(shell: string | null): "bash" | "powershell" | null {
  if (!shell) return null;
  const name = shell.toLowerCase().replace(/\.exe$/u, "");
  if (name === "bash" || name === "sh") return "bash";
  if (name === "powershell") return "powershell";
  return null;
}

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
  const osLabel = platform ? OS_LABEL[platform] : null;
  const lines: string[] = [];
  if (osLabel) {
    const arch = pick(DEVICE_ARCHES, device.arch);
    lines.push(`Operating system: ${osLabel}${arch ? ` (${arch})` : ""}`);
    if (device.shell && DEVICE_SHELL_PATTERN.test(device.shell))
      lines.push(`Shell: ${device.shell} (commands run under this shell)`);
    lines.push(
      platform === "windows"
        ? WINDOWS_PATH_LINE
        : "Paths are POSIX-style: forward slashes, and absolute paths start with /.",
    );
  }
  if (device.sandboxState === "needsSetup") {
    lines.push(NEEDS_SETUP_SENTENCE);
  } else if (platform === "linux" && device.sandboxState !== "unsupported") {
    lines.push(...LINUX_SANDBOX_RULES);
  } else if (platform === "windows" && device.sandboxState !== "unsupported") {
    const kind = windowsShellKind(device.shell);
    lines.push(
      ...WINDOWS_SANDBOX_RULES,
      ...(kind === "bash"
        ? WINDOWS_GIT_BASH_RULES
        : kind === "powershell"
          ? WINDOWS_POWERSHELL_RULES
          : []),
    );
  }
  return lines.join("\n");
}
