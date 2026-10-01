import { EXIT_INSTANCE_CHANGED, TAIL_MARKER } from "./constants";
import type { FlushReport, ParsedCommandOutput } from "./types";

/**
 * Strip the wrapper's tail marker (`\n__SWVOL__ <rc> <json>\n`) from a command's combined output.
 * The marker is always the last occurrence; anything the user command printed stays untouched.
 */
export function parseCommandOutput(output: string): ParsedCommandOutput {
  const at = output.lastIndexOf(TAIL_MARKER);
  if (at < 0) {
    return { output, flushExitCode: null, flush: null, instanceChanged: false, markerFound: false };
  }
  const before = output.slice(0, at).replace(/\n$/, "");
  const tail = output.slice(at + TAIL_MARKER.length).trim();
  const space = tail.indexOf(" ");
  const codeText = space < 0 ? tail : tail.slice(0, space);
  const jsonText = space < 0 ? "" : tail.slice(space + 1).trim();
  const flushExitCode = /^-?\d+$/.test(codeText) ? Number.parseInt(codeText, 10) : null;
  let flush: FlushReport | null = null;
  if (jsonText) {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      flush = typeof parsed === "object" && parsed !== null ? (parsed as FlushReport) : { raw: jsonText.slice(0, 200) };
    } catch {
      flush = { raw: jsonText.slice(0, 200) };
    }
  }
  return {
    output: before,
    flushExitCode,
    flush,
    instanceChanged: flushExitCode === EXIT_INSTANCE_CHANGED,
    markerFound: true,
  };
}
