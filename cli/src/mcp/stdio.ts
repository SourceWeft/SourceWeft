import { spawn, type ChildProcess } from "node:child_process";
import { McpInspectError } from "../errors";
import {
  isRecord,
  isServerMethodCall,
  methodNotFound,
  resultOf,
  type McpTransport,
} from "./jsonrpc";

/**
 * MCP over stdio: the server is started through the user's shell with this
 * process's environment, which is how the owner's own credentials reach it,
 * and spoken to in newline-delimited JSON-RPC. Nothing of that environment is
 * read here; the process is stopped when the handshake is over.
 */

/** The whole inspection, from start to the last tools page. */
export const STDIO_TIMEOUT_MS = 60_000;
/** Bytes of stderr kept for an error message. */
const STDERR_TAIL_CHARS = 4_096;
/** Bytes one JSON-RPC line may hold. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL when stopping the server. */
const KILL_GRACE_MS = 2_000;

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function shellCommand(command: string): [string, string[]] {
  return process.platform === "win32"
    ? ["cmd", ["/c", command]]
    : ["sh", ["-c", command]];
}

/** The last non-empty lines of a log, for a one-line detail. */
function lastLines(text: string, count = 3): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" | ");
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // On POSIX the shell was started as a process-group leader so the server
  // it ran (and anything that one started) goes with it.
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone or was never created; fall through to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** SIGTERM, then SIGKILL after the grace period; resolves once it has exited. */
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      resolve();
    };
    child.once("exit", done);
    signalProcess(child, "SIGTERM");
    const killTimer = setTimeout(
      () => signalProcess(child, "SIGKILL"),
      KILL_GRACE_MS,
    );
    const giveUp = setTimeout(done, 2 * KILL_GRACE_MS);
  });
}

export function createStdioTransport(
  command: string,
  options: { timeoutMs?: number; cwd?: string } = {},
): McpTransport {
  const [file, args] = shellCommand(command);
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let stderrTail = "";
  let buffer: Buffer = Buffer.alloc(0);
  let failure: Error | undefined;
  let closed = false;

  const failAll = (error: Error) => {
    failure ??= error;
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(error);
    }
  };
  const detail = () => {
    const tail = lastLines(stderrTail);
    return tail ? `: ${tail}` : "";
  };

  const deadline = setTimeout(() => {
    const waiting = [...pending.values()].map((p) => p.method).join(", ");
    failAll(
      new McpInspectError(
        `The server did not finish within ${Math.round((options.timeoutMs ?? STDIO_TIMEOUT_MS) / 1000)} s${
          waiting ? ` (waiting on ${waiting})` : ""
        }${detail()}`,
      ),
    );
    void stop(child);
  }, options.timeoutMs ?? STDIO_TIMEOUT_MS);

  // Ctrl+C must not leave the server running in the background.
  const onSignal = (signal: NodeJS.Signals) => {
    signalProcess(child, "SIGKILL");
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const release = () => {
    clearTimeout(deadline);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };

  const send = (message: Record<string, unknown>) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      failAll(
        new McpInspectError(
          `Could not write to the server: ${error instanceof Error ? error.message : String(error)}${detail()}`,
        ),
      );
    }
  };

  const onMessage = (message: Record<string, unknown>) => {
    if (isServerMethodCall(message)) {
      // A request the server makes of its client (roots/list, sampling,
      // elicitation), or a notification. This client offers none of them.
      if (message.id !== undefined && message.id !== null) {
        send(methodNotFound(message.id));
      }
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") {
      return;
    }
    const waiter = pending.get(Number(message.id));
    if (!waiter) return;
    pending.delete(Number(message.id));
    try {
      waiter.resolve(resultOf(message, waiter.method));
    } catch (error) {
      waiter.reject(error as Error);
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    let newline: number;
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      buffer = buffer.subarray(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a banner or log line on stdout, not a frame
      }
      if (isRecord(message)) onMessage(message);
    }
    if (buffer.length > MAX_LINE_BYTES) {
      failAll(
        new McpInspectError("The server wrote a frame larger than 4 MiB."),
      );
      void stop(child);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(
      -STDERR_TAIL_CHARS,
    );
  });
  child.stdin.on("error", () => {
    // EPIPE after the server exited: `close` below reports it.
  });
  child.on("error", (error) => {
    failAll(
      new McpInspectError(
        `The server could not be started (${command}): ${error.message}`,
      ),
    );
  });
  child.on("close", (code, signal) => {
    if (closed) return;
    failAll(
      new McpInspectError(
        `The server exited with ${code ?? signal} before finishing${detail()}`,
      ),
    );
  });

  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      if (failure) return Promise.reject(failure);
      send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      return Promise.resolve();
    },
    async close() {
      closed = true;
      release();
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      await stop(child);
    },
  };
}
