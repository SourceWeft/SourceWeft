import { closeSync, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";
import { ConfirmationRequiredError } from "./errors";

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Left-aligns rows into columns, padding all but the last. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
}

/** A terminal the user is at, separate from the standard streams. */
export type Terminal = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  close: () => void;
};

/**
 * The terminal the process was started from, even when its standard input is a
 * pipe: `/dev/tty` on POSIX, the console on Windows. Null when there is none
 * (a CI job, a detached process), which is how a caller knows nobody can be
 * asked.
 */
export function openControllingTerminal(
  platform: NodeJS.Platform = process.platform,
): Terminal | null {
  const paths =
    platform === "win32" ? (["CONIN$", "CONOUT$"] as const) : (["/dev/tty", "/dev/tty"] as const);
  let readFd: number | undefined;
  let writeFd: number | undefined;
  try {
    readFd = openSync(paths[0], "r");
    writeFd = openSync(paths[1], "w");
    const input = new ReadStream(readFd);
    const output = new WriteStream(writeFd);
    return {
      input,
      output,
      close: () => {
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    for (const fd of [readFd, writeFd]) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
      }
    }
    return null;
  }
}

/**
 * Asks a yes/no question. With `assumeYes` it says yes; with no terminal to ask
 * it refuses rather than guessing, since what is being confirmed is running
 * someone else's code or sending a credential. `viaTerminal` asks on the
 * controlling terminal when standard input is not one (a key was piped in).
 */
export async function confirm(
  question: string,
  options: {
    assumeYes: boolean;
    viaTerminal?: boolean;
    /** Replaceable in tests. */
    openTerminal?: () => Terminal | null;
  },
): Promise<boolean> {
  if (options.assumeYes) {
    return true;
  }
  let terminal: Terminal | null = null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    terminal = options.viaTerminal
      ? (options.openTerminal ?? openControllingTerminal)()
      : null;
    if (!terminal) throw new ConfirmationRequiredError();
  }
  const rl = createInterface(
    terminal
      ? { input: terminal.input, output: terminal.output }
      : { input: process.stdin, output: process.stdout },
  );
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/iu.test(answer.trim());
  } finally {
    rl.close();
    terminal?.close();
  }
}

type RawInput = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Reads one line from a terminal without showing it: raw mode, no echo,
 * backspace edits, Enter ends, Ctrl-C cancels. For a key the user types.
 */
export function readHiddenLine(
  input: RawInput,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let line = "";
    const finish = (done: () => void) => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      done();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          finish(() => resolve(line));
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          finish(() => reject(new Error("Cancelled; nothing was sent.")));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          line = line.slice(0, -1);
        } else if (char >= " ") {
          line += char;
        }
      }
    };
    output.write(prompt);
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}

/** Selection is independent of installation consent: --yes never picks a source. */
export async function chooseItem(labels: readonly string[]): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Multiple sources match. Specify an exact install reference or --path.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      labels.map((label, i) => `${i + 1}. ${label}`).join("\n") +
        "\nChoose a source number (Enter to cancel): ",
    );
    const index = Number(answer) - 1;
    if (
      !answer.trim() ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= labels.length
    )
      throw new Error("No source selected; nothing installed.");
    return index;
  } finally {
    rl.close();
  }
}
