import Anser from "anser";
import { escapeCarriageReturn } from "escape-carriage";
import type { CSSProperties } from "react";

export type TerminalAnsiSegment = {
  content: string;
  style: CSSProperties;
};

function applyBackspaces(input: string) {
  const output: string[] = [];

  for (const character of input) {
    if (character !== "\b") {
      output.push(character);
      continue;
    }

    if (output.at(-1) !== "\n") {
      output.pop();
    }
  }

  return output.join("");
}

function createStyle(
  bundle: ReturnType<typeof Anser.ansiToJson>[number],
): CSSProperties {
  const style: CSSProperties = {};

  if (bundle.bg) {
    style.backgroundColor = `rgb(${bundle.bg})`;
  }
  if (bundle.fg) {
    style.color = `rgb(${bundle.fg})`;
  }

  switch (bundle.decoration) {
    case "bold":
      style.fontWeight = "bold";
      break;
    case "dim":
      style.opacity = 0.5;
      break;
    case "italic":
      style.fontStyle = "italic";
      break;
    case "hidden":
      style.visibility = "hidden";
      break;
    case "strikethrough":
      style.textDecoration = "line-through";
      break;
    case "underline":
      style.textDecoration = "underline";
      break;
    default:
      break;
  }

  return style;
}

/**
 * Parse terminal output into text-only React styling data. Linkification is
 * intentionally unsupported: terminal output may be attacker-controlled and
 * SourceWeft does not need clickable terminal links.
 */
export function parseTerminalAnsi(input: string): TerminalAnsiSegment[] {
  const normalized = escapeCarriageReturn(applyBackspaces(input));

  return Anser.ansiToJson(normalized, {
    json: true,
    remove_empty: true,
    use_classes: false,
  }).map((bundle) => ({
    content: bundle.content,
    style: createStyle(bundle),
  }));
}
