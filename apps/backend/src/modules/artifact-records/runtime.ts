import type { ArtifactExecutionPolicy } from "@sourceweft/contracts/artifact-execution";
import {
  buildArtifactRuntimeScript,
  injectArtifactRuntime,
} from "@sourceweft/contracts/artifact-runtime";
import { logger } from "../../shared/logger";

/**
 * The bytes to serve when the host renders an HTML artifact in its iframe.
 *
 * Only the render request (`runtime=1`) gets the runtime; downloads, the
 * source view and integrity checks keep the exact published bytes. The stored
 * object is never modified.
 */
export function renderableArtifactBody<Body extends Uint8Array>(
  file: {
    body: Body;
    executionPolicy?: ArtifactExecutionPolicy;
    recordCapabilities?: { storage: boolean };
  },
  runtimeRequested: boolean,
): Body | Buffer<ArrayBuffer> {
  if (!runtimeRequested || file.executionPolicy !== "sandboxed-html")
    return file.body;
  const injected = injectArtifactRuntime(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.body),
    buildArtifactRuntimeScript({
      storage: file.recordCapabilities?.storage ?? false,
    }),
  );
  if (injected === null) {
    logger.warn("artifact_runtime_injection_skipped", {
      reason: "no_html_start_tag",
    });
    return file.body;
  }
  return Buffer.from(injected, "utf8");
}
