import { isIP } from "node:net";
import type { MarketMcpManifest } from "@sourceweft/market-contracts";
import type { McpParserReport } from "./types";

export type SubmissionScan = {
  reviewRequired: boolean;
  flags: string[];
};

// Patterns in install commands / connection args that warrant human review.
// Matching one does NOT mean the server is malicious — it means "don't auto
// publish; a person should look." The registry is not a security audit.
const RISKY_COMMAND_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "pipe-to-shell", re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i },
  { code: "sudo", re: /\bsudo\b/i },
  { code: "eval", re: /\beval\s*\(/i },
  { code: "base64-exec", re: /base64\s+(-d|--decode)[^\n|]*\|\s*(ba)?sh\b/i },
  { code: "chmod-exec", re: /\bchmod\s+\+x\b/i },
];

function scanText(text: string, flags: Set<string>) {
  for (const { code, re } of RISKY_COMMAND_PATTERNS) {
    if (re.test(text)) {
      flags.add(`command:${code}`);
    }
  }
}

function hostIsSuspicious(endpointUrl: string): boolean {
  try {
    const host = new URL(endpointUrl).hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "metadata.google.internal" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return true;
    }
    // Literal private / loopback / link-local (incl. cloud metadata) addresses.
    if (isIP(host)) {
      return (
        host.startsWith("127.") ||
        host.startsWith("10.") ||
        host.startsWith("169.254.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host === "0.0.0.0" ||
        host === "::1"
      );
    }
    return false;
  } catch {
    return true; // an unparseable endpoint is itself a reason to look
  }
}

/**
 * Static safety scan over a parsed submission. Flags risky install commands and
 * endpoints that point at internal/metadata addresses. Returns reviewRequired
 * so the caller can route clean submissions straight to published and flagged
 * ones into the review queue.
 */
export function scanMcpSubmission(input: {
  manifest: MarketMcpManifest;
  report: McpParserReport;
}): SubmissionScan {
  const flags = new Set<string>();

  for (const command of input.report.installCommands ?? []) {
    scanText(command, flags);
  }
  for (const connection of input.report.connections ?? []) {
    if (connection.command) {
      scanText([connection.command, ...(connection.args ?? [])].join(" "), flags);
    }
    if (connection.endpointUrl && hostIsSuspicious(connection.endpointUrl)) {
      flags.add("endpoint:internal-address");
    }
  }
  if (
    input.manifest.endpointUrl &&
    hostIsSuspicious(input.manifest.endpointUrl)
  ) {
    flags.add("endpoint:internal-address");
  }

  const list = [...flags];
  return { reviewRequired: list.length > 0, flags: list };
}
