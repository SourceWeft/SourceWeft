// The in-sandbox half of the stdio package validation (Issue #367, W1b).
//
// Uploaded into a fresh sandbox next to a plan file and run there with the
// sandbox image's Node: `node stdio-driver.mjs plan.json result.json`. It
// installs the package, starts the MCP server over stdio, performs the
// handshake — `initialize`, `notifications/initialized`, `tools/list` — and
// writes what it learnt to the result file, then kills the server's whole
// process group. It never reads a credential: the server's environment is a
// short allowlist of this process's variables plus the plan's placeholders.
//
// Plain ES2022 with no dependency, so the one file runs under the sandbox's
// Node as well as under the host's test runner (`stdio-driver.test.ts` starts
// it against fake servers). Keep it that way: nothing here may import from
// the backend.
//
// Plan (written by `stdio-package.ts`):
//   { install, start, env, installTimeoutMs, runTimeoutMs, cpuSeconds }
// Result (read by `stdio-state.ts`):
//   { ok: true, protocolVersion?, serverInfo?, instructions?, capabilities?,
//     tools, timings: { installMs, startMs }, stderrTail }
//   { ok: false, reason: "install"|"start"|"protocol"|"timeout", detail,
//     exitCode?, timings, stderrTail }

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

/** Variables of this process the server may see; everything else is dropped. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TERM",
  "NODE_VERSION",
  "NODE_PATH",
  "PNPM_HOME",
  "VIRTUAL_ENV",
];

/** The protocol version this client speaks; servers answer with theirs. */
const PROTOCOL_VERSION = "2025-06-18";
/** Bytes of stdout a server may write before it is given up on. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
/** Bytes one JSON-RPC line may hold (a page of tools is far below). */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** Bytes of stderr kept for the result's detail. */
const STDERR_TAIL_BYTES = 4096;
/** `tools/list` pages followed, and tools kept, for one server. */
const MAX_TOOL_PAGES = 5;
const MAX_TOOLS = 200;
/** Grace between SIGTERM and SIGKILL when stopping the server. */
const KILL_GRACE_MS = 2000;
/** How long after the SIGKILL the driver still waits for the exit. */
const KILL_WAIT_MS = 1000;

const [planPath, resultPath] = process.argv.slice(2);
if (!planPath || !resultPath) {
  console.error("usage: node stdio-driver.mjs <plan.json> <result.json>");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const startedAt = Date.now();

function serverEnvironment() {
  const env = {};
  for (const name of INHERITED_ENV) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(plan.env ?? {})) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/** Keeps the last `limit` bytes of what was appended. */
class Tail {
  #chunks = [];
  #size = 0;
  constructor(limit) {
    this.limit = limit;
  }
  push(chunk) {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.limit && this.#chunks.length > 1) {
      this.#size -= this.#chunks.shift().length;
    }
  }
  toString() {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    return text.length > this.limit ? text.slice(-this.limit) : text;
  }
}

/** `sh -c` with the CPU budget applied to the shell and all it starts. */
function shellCommand(command) {
  const cpu = Number.isInteger(plan.cpuSeconds) ? plan.cpuSeconds : 120;
  return ["sh", ["-c", `ulimit -t ${cpu} 2>/dev/null; ${command}`]];
}

/**
 * SIGTERM the child's process group, SIGKILL it after the grace period, and
 * resolve once it has exited — or shortly after the SIGKILL, so a process the
 * kernel will not reap cannot hold the driver (and the sandbox) open.
 */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const done = () => {
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      resolve();
    };
    child.once("exit", () => {
      // The shell (or npx) is gone; a grandchild that ignored the SIGTERM
      // may not be. Give the group the same grace, then SIGKILL what is left.
      const until = Date.now() + KILL_GRACE_MS;
      const poll = () => {
        if (!groupAlive()) {
          done();
        } else if (Date.now() >= until) {
          signalGroup("SIGKILL");
          setTimeout(done, 100);
        } else {
          setTimeout(poll, 100);
        }
      };
      poll();
    });
    signalGroup("SIGTERM");
    const killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    const giveUp = setTimeout(done, 2 * KILL_GRACE_MS + KILL_WAIT_MS);
  });
}

function runInstall() {
  return new Promise((resolve) => {
    const [file, args] = shellCommand(plan.install);
    const stderr = new Tail(STDERR_TAIL_BYTES);
    const stdout = new Tail(STDERR_TAIL_BYTES);
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: serverEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const begun = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child);
    }, plan.installTimeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: "install",
        detail: `install could not start: ${error.message}`,
        installMs: Date.now() - begun,
        stderrTail: stderr.toString(),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const installMs = Date.now() - begun;
      if (timedOut) {
        resolve({
          ok: false,
          reason: "timeout",
          detail: `install did not finish within ${Math.round(plan.installTimeoutMs / 1000)} s`,
          installMs,
          stderrTail: stderr.toString(),
        });
      } else if (code !== 0) {
        resolve({
          ok: false,
          reason: "install",
          detail: `install exited with ${code ?? signal}: ${lastLines(stderr.toString() || stdout.toString())}`,
          exitCode: code,
          installMs,
          stderrTail: stderr.toString(),
        });
      } else {
        resolve({ ok: true, installMs, stderrTail: stderr.toString() });
      }
    });
  });
}

/** The last non-empty lines of a log, for a one-line detail. */
function lastLines(text, count = 3) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" | ");
}

/**
 * Starts the server and runs the handshake. Resolves with the result object;
 * never rejects. Every path through here stops the server.
 */
function runServer() {
  return new Promise((resolve) => {
    const [file, args] = shellCommand(plan.start);
    const stderr = new Tail(STDERR_TAIL_BYTES);
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: serverEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const begun = Date.now();
    let settled = false;
    let pending = Buffer.alloc(0);
    let stdoutBytes = 0;
    let nextId = 1;
    const waiting = new Map();
    const tools = [];
    let initializeResult;
    let pagesRead = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // The server is gone (or SIGKILLed) by the time the result is written.
      void stop(child).then(() =>
        resolve({
          ...result,
          startMs: Date.now() - begun,
          stderrTail: stderr.toString(),
        }),
      );
    };
    const fail = (reason, detail, extra = {}) =>
      finish({ ok: false, reason, detail, ...extra });

    const deadline = setTimeout(() => {
      fail(
        "timeout",
        initializeResult
          ? `server did not answer tools/list within ${Math.round(plan.runTimeoutMs / 1000)} s`
          : `server did not answer initialize within ${Math.round(plan.runTimeoutMs / 1000)} s`,
      );
    }, plan.runTimeoutMs);

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        fail("start", `could not write to the server: ${error.message}`);
      }
    };
    const request = (method, params, onResult) => {
      const id = nextId++;
      waiting.set(id, onResult);
      send({ jsonrpc: "2.0", id, method, params });
    };

    const onMessage = (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message))
        return;
      if (typeof message.method === "string") {
        // A notification, or a request the server makes of its client
        // (roots/list, sampling, elicitation) whose id may collide with one
        // of ours: never a response. This client offers none of them.
        if (message.id !== undefined && message.id !== null) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        return;
      }
      if (message.id === undefined || message.id === null) return;
      const handler = waiting.get(Number(message.id));
      if (!handler) return;
      waiting.delete(Number(message.id));
      if (message.error !== undefined) {
        const error = message.error;
        const text =
          error &&
          typeof error === "object" &&
          typeof error.message === "string"
            ? error.message
            : JSON.stringify(error);
        fail(
          "protocol",
          `server answered with an error: ${String(text).slice(0, 300)}`,
        );
        return;
      }
      handler(message.result);
    };

    const listTools = (cursor) => {
      request("tools/list", cursor ? { cursor } : {}, (result) => {
        pagesRead += 1;
        if (
          !result ||
          typeof result !== "object" ||
          !Array.isArray(result.tools)
        ) {
          fail("protocol", "tools/list answered without a tools array");
          return;
        }
        for (const tool of result.tools) {
          if (tools.length < MAX_TOOLS) tools.push(tool);
        }
        const next =
          typeof result.nextCursor === "string" ? result.nextCursor : null;
        if (next && pagesRead < MAX_TOOL_PAGES && tools.length < MAX_TOOLS) {
          listTools(next);
          return;
        }
        finish({
          ok: true,
          protocolVersion: initializeResult.protocolVersion,
          serverInfo: initializeResult.serverInfo,
          instructions: initializeResult.instructions,
          capabilities: initializeResult.capabilities,
          tools,
        });
      });
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail("protocol", "server wrote too much to stdout");
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline).toString("utf8").trim();
        pending = pending.subarray(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // a banner or log line on stdout, not a frame
        }
        onMessage(message);
        if (settled) return;
      }
      if (pending.length > MAX_LINE_BYTES) {
        fail("protocol", "server wrote a frame larger than the line limit");
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {
      // EPIPE after the server exited: `close` below reports it.
    });
    child.on("error", (error) => {
      fail("start", `server could not start: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      const exit = code ?? signal;
      fail(
        initializeResult ? "protocol" : "start",
        initializeResult
          ? `server exited with ${exit} before answering tools/list: ${lastLines(stderr.toString())}`
          : `server exited with ${exit} before answering initialize: ${lastLines(stderr.toString())}`,
        { exitCode: code },
      );
    });

    request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "sourceweft-stdio-validation", version: "1" },
      },
      (result) => {
        if (!result || typeof result !== "object") {
          fail("protocol", "initialize answered without a result object");
          return;
        }
        initializeResult = result;
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        listTools(null);
      },
    );
  });
}

async function main() {
  const timings = { installMs: 0, startMs: 0 };
  if (typeof plan.install === "string" && plan.install) {
    const install = await runInstall();
    timings.installMs = install.installMs;
    if (!install.ok) {
      return {
        ok: false,
        reason: install.reason,
        detail: install.detail,
        exitCode: install.exitCode,
        timings,
        stderrTail: install.stderrTail,
      };
    }
  }
  const run = await runServer();
  timings.startMs = run.startMs;
  const { startMs: _startMs, ...rest } = run;
  return { ...rest, timings };
}

main()
  .catch((error) => ({
    ok: false,
    reason: "start",
    detail: `driver failed: ${error instanceof Error ? error.message : String(error)}`,
    timings: { installMs: 0, startMs: Date.now() - startedAt },
    stderrTail: "",
  }))
  .then((result) => {
    writeFileSync(resultPath, JSON.stringify(result));
    console.log(
      result.ok
        ? `ok tools=${result.tools.length} install=${result.timings.installMs}ms start=${result.timings.startMs}ms`
        : `failed reason=${result.reason} install=${result.timings.installMs}ms start=${result.timings.startMs}ms`,
    );
    // The server's process group has exited (or was SIGKILLed and given a
    // moment); do not wait on any pipe a grandchild may still hold.
    process.exit(0);
  });
