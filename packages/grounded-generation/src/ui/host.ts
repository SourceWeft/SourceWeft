import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";

/**
 * The slice of an artifact viewer's host that the shared evidence and
 * staleness components need. An artifact package (study, data tables) hosts
 * these components by providing a value here, normally from its own, larger
 * host. Nothing is provided by default: a component rendered without a host
 * gets `readOnlyGroundedHost`, which records nothing and opens nothing.
 */

/** Which artifact version a viewer shows. */
export type GroundedVersionRef = {
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string | null;
};

export type GroundedFreshness = {
  /**
   * `stale`: an input source changed since generation; `source_deleted`: one
   * was removed (the artifact stays usable); `unknown`: not checked.
   */
  readonly status: "fresh" | "stale" | "source_deleted" | "unknown";
};

export type GroundedTranslate = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export type GroundedHost = {
  /** False on public or signed-out surfaces: nothing is written, grading is hidden. */
  readonly interactive: boolean;
  /**
   * Translations for the evidence and staleness strings. A React hook — only
   * legal from a component's render, so the app can back it with its i18n
   * provider.
   */
  readonly useTranslate: () => GroundedTranslate;
  /** Opens the source at the quote (the app's source preview). */
  openEvidence(
    evidence: GroundedEvidence,
    context: { workspaceId: string; artifactId: string },
  ): void;
  /**
   * `sha256:` digest of the text now at the evidence's range, or null when the
   * chunk no longer exists. The viewer compares it with `quoteHash`.
   */
  currentQuoteHash(
    evidence: GroundedEvidence,
    context: { workspaceId: string; artifactId: string },
  ): Promise<string | null>;
  getFreshness(ref: GroundedVersionRef): Promise<GroundedFreshness>;
  /** Present when the app can regenerate (retry a failure, refresh a stale artifact). */
  readonly requestRegenerate?: (ref: GroundedVersionRef) => void;
};

/** Without translations the key itself is shown. */
const passthroughTranslate: GroundedTranslate = (key) => key;

export const readOnlyGroundedHost: GroundedHost = {
  interactive: false,
  useTranslate: () => passthroughTranslate,
  openEvidence: () => {},
  currentQuoteHash: () => Promise.reject(new Error("Evidence lookup is not available here")),
  getFreshness: async () => ({ status: "unknown" }),
};

let configuredHost: GroundedHost | null = null;

/** Installed once by the app shell (through the artifact package's own configure call). */
export function configureGroundedHost(host: GroundedHost | null) {
  configuredHost = host;
}

const GroundedHostContext = createContext<GroundedHost | null>(null);

/** Overrides the configured host for a subtree (tests, the share page). */
export function GroundedHostProvider({
  host,
  children,
}: {
  host: GroundedHost;
  children?: ReactNode;
}) {
  return createElement(GroundedHostContext.Provider, { value: host }, children);
}

export function useGroundedHost(): GroundedHost {
  return useContext(GroundedHostContext) ?? configuredHost ?? readOnlyGroundedHost;
}
