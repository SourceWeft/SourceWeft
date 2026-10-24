import { spawn } from "node:child_process";

/**
 * Opens the authorization URL in the user's browser without a shell: the URL
 * is one argument of the launcher, never part of a command line another
 * program parses. Windows uses `rundll32 url.dll,FileProtocolHandler` for
 * that reason; `cmd /c start` would hand the URL's `&` to cmd.exe.
 */

export type BrowserCommand = { file: string; args: string[] };

/** What to run to open `url` on this platform, or null when it cannot work. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>> = {},
): BrowserCommand | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // `URL.href` is percent-encoded and holds no space, quote or control byte.
  const href = parsed.href;
  switch (platform) {
    case "darwin":
      return { file: "open", args: [href] };
    case "win32":
      return { file: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
    default:
      // A Linux box without a display, or a remote shell, has no browser to
      // reach and its loopback port is not the user's.
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
      if (env.SSH_CONNECTION || env.SSH_TTY) return null;
      return { file: "xdg-open", args: [href] };
  }
}

/** How long a launcher that stays running is trusted to have worked. */
const LAUNCH_SETTLE_MS = 3_000;

/** Starts the browser; false when it could not be launched. */
export function openBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<boolean> {
  const command = browserCommand(
    url,
    options.platform ?? process.platform,
    options.env ?? process.env,
  );
  if (!command) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command.file, command.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.unref();
      finish(true);
    }, LAUNCH_SETTLE_MS);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.unref();
  });
}
