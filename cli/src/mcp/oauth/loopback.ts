import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpInspectError } from "../../errors";
import { printable } from "./redact";

/**
 * The redirect target of the authorization-code flow: a short-lived HTTP
 * server bound to the loopback interface only, on a port the OS picks. It
 * answers `GET /callback` once, checks the `state` it was given and hands the
 * code back. A browser on another machine cannot reach it.
 */

export const CALLBACK_PATH = "/callback";
/** How long the user has to approve in the browser. */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export type CallbackResult = { code: string };

export type LoopbackListener = {
  /** The redirect URI to register and send. */
  redirectUri: string;
  /** Resolves with the authorization code; rejects on error, timeout or abort. */
  result: Promise<CallbackResult>;
  /**
   * Starts the wait: the time limit runs from here, so it covers only the
   * person's part (the browser), not discovery or registration before it.
   */
  startTimer: () => void;
  /** Releases the port and the timer; safe to call more than once. */
  close: () => Promise<void>;
};

export type LoopbackOptions = {
  expectedState: string;
  /** The authorization server's issuer; an `iss` parameter must match it. */
  issuer?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Replaceable in tests to reproduce a host without IPv4 loopback. */
  hosts?: readonly string[];
  /** The OS picks a free port (0) unless a test needs a busy one. */
  port?: number;
};

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem auto;max-width:32rem"><h1>${title}</h1><p>${body}</p></body>`;

function describeDuration(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} minute${ms >= 90_000 ? "s" : ""}`
    : `${Math.max(1, Math.round(ms / 1000))} second${ms >= 1500 ? "s" : ""}`;
}

function listenOn(
  server: Server,
  host: string,
  port: number,
): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host, port }, () => {
      server.off("error", onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

function describeBindError(error: unknown, host: string): McpInspectError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    return new McpInspectError(
      `The loopback port for the sign-in callback on ${host} is already in use. Run the command again to get another port.`,
    );
  }
  return new McpInspectError(
    `Could not open the sign-in callback on ${host} (${error instanceof Error ? error.message : String(error)}).`,
  );
}

export async function startLoopbackListener(
  options: LoopbackOptions,
): Promise<LoopbackListener> {
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const hosts = options.hosts ?? ["127.0.0.1", "::1"];

  let settle: {
    resolve: (value: CallbackResult) => void;
    reject: (error: Error) => void;
  };
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller awaits `result`; an early rejection must not look unhandled.
  result.catch(() => {});

  let boundHost = "";
  let boundPort = 0;
  const server = createServer((req, res) => {
    const headers = {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      connection: "close",
    };
    const reply = (status: number, title: string, body: string) => {
      res.writeHead(status, headers);
      res.end(PAGE(title, body));
    };

    // A page on the web can make the browser call this port under any host
    // name it controls (DNS rebinding); only the literal loopback address
    // this server was given is the real redirect.
    const hostHeader = req.headers.host ?? "";
    const expectedHost =
      boundHost === "::1" ? `[::1]:${boundPort}` : `${boundHost}:${boundPort}`;
    if (hostHeader !== expectedHost) {
      reply(400, "Wrong address", "This is not the sign-in callback.");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${expectedHost}`);
    } catch {
      reply(400, "Bad request", "This is not the sign-in callback.");
      return;
    }
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      reply(404, "Not found", "This is not the sign-in callback.");
      return;
    }

    const fail = (message: string, shown: string) => {
      reply(400, "Sign-in failed", shown);
      settle.reject(new McpInspectError(message));
    };
    const params = url.searchParams;
    if (params.get("state") !== options.expectedState) {
      fail(
        "The sign-in callback carried a different state than this command sent, so it was ignored and the sign-in was cancelled. Run the command again.",
        "The sign-in could not be completed. Return to the terminal.",
      );
      return;
    }
    const issuer = params.get("iss");
    if (
      issuer !== null &&
      options.issuer !== undefined &&
      issuer !== options.issuer
    ) {
      fail(
        "The sign-in callback came from a different authorization server than the one this command used.",
        "The sign-in could not be completed. Return to the terminal.",
      );
      return;
    }
    const error = params.get("error");
    if (error) {
      const description = printable(params.get("error_description"));
      fail(
        error === "access_denied"
          ? `Access was denied in the browser${description ? ` (${description})` : ""}.`
          : `The authorization server refused the sign-in: ${printable(error)}${description ? ` (${description})` : ""}.`,
        "Access was not granted. You can close this tab.",
      );
      return;
    }
    const code = params.get("code");
    if (!code) {
      fail(
        "The sign-in callback held no authorization code.",
        "The sign-in could not be completed. Return to the terminal.",
      );
      return;
    }
    reply(
      200,
      "Signed in",
      "You can close this tab and return to the terminal.",
    );
    settle.resolve({ code });
  });
  // A browser keeps its connection open; do not let it hold the process.
  server.keepAliveTimeout = 1;

  let lastError: unknown;
  for (const host of hosts) {
    try {
      const address = await listenOn(server, host, options.port ?? 0);
      boundHost = host;
      boundPort = address.port;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      // Only a host without that address is worth trying the other family;
      // a busy port is reported as it is.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") {
        throw describeBindError(error, host);
      }
    }
  }
  if (!boundHost) throw describeBindError(lastError, hosts.join("/"));

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const startTimer = () => {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      settle.reject(
        new McpInspectError(
          `No sign-in arrived within ${describeDuration(timeoutMs)}. Run the command again and finish the browser step sooner.`,
        ),
      );
    }, timeoutMs);
  };
  const onAbort = () =>
    settle.reject(new McpInspectError("The sign-in was cancelled."));
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const hostInUri = boundHost === "::1" ? "[::1]" : boundHost;
  return {
    redirectUri: `http://${hostInUri}:${boundPort}${CALLBACK_PATH}`,
    result,
    startTimer,
    close,
  };
}
