import { createInterface } from "node:readline/promises";
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

/**
 * Asks a yes/no question. With `assumeYes` it says yes; with no terminal to ask
 * it refuses rather than guessing, since what is being confirmed is running
 * someone else's code.
 */
export async function confirm(
  question: string,
  options: { assumeYes: boolean },
): Promise<boolean> {
  if (options.assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfirmationRequiredError();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
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
