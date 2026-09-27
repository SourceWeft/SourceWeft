import { createHash } from "node:crypto";
import type { SystemModelIdentity } from "../../shared/model-gateway/system-client";
import type { OverviewPrompt } from "./types";

/**
 * The keys an overview result is stored and reused under. Pure: no model,
 * database or configuration is reached from here.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The key a result is stored and reused under: the input fingerprint, the
 * whole prompt, and the model it ran on. Its field names are frozen — stored
 * skill results were keyed with them, and renaming one would orphan them.
 */
export function overviewResultKey(input: {
  fingerprint: string;
  prompt: OverviewPrompt;
  model: string;
}): string {
  return sha256(
    JSON.stringify({
      bundle: input.fingerprint,
      prompt: input.prompt,
      model: input.model,
    }),
  );
}

/**
 * Non-secret identity of the model an analysis ran on: the system model's
 * Provider, endpoint and model. Credentials and their rotation are excluded.
 */
export function overviewModelIdentity(identity: SystemModelIdentity) {
  return {
    provider: identity.provider,
    kind: identity.kind,
    baseUrl: identity.baseUrl,
    apiVersion: identity.apiVersion,
    model: identity.model,
  };
}

/** The model-configuration key: a change of model or endpoint changes it. */
export function overviewModelConfigurationKey(identity: SystemModelIdentity) {
  return sha256(
    JSON.stringify({ systemModel: overviewModelIdentity(identity) }),
  );
}
