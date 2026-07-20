import {
  collectArtifactViewHandlers,
  createArtifactViewHandlerRegistry as buildArtifactViewHandlerRegistry,
  EMPTY_ARTIFACT_VIEW_HANDLER_REGISTRY,
  type ArtifactViewHandlerRegistry,
  type ArtifactViewHandlerWarning,
} from "@sourceweft/agent-tool-registry";
import type { ArtifactViewHandler } from "@sourceweft/contracts";
import { logger } from "../../shared/logger";

/**
 * Host wiring for the read-side artifact handler registry.
 *
 * Collection and indexing live in the capability registry package; the backend
 * only supplies logging and memoizes the result.
 */

export type { ArtifactViewHandlerRegistry };

function logWarning(warning: ArtifactViewHandlerWarning) {
  if (warning.kind === "conflict") {
    logger.warn("artifact_view_handler_conflict", {
      artifactType: warning.artifactType,
    });
    return;
  }
  logger.warn("artifact_view_handler_load_failed", {
    packageName: warning.packageName,
    error:
      warning.error instanceof Error
        ? warning.error.message
        : String(warning.error),
  });
}

export function createArtifactViewHandlerRegistry(
  handlers: readonly ArtifactViewHandler[],
): ArtifactViewHandlerRegistry {
  return buildArtifactViewHandlerRegistry(handlers, { onWarn: logWarning });
}

let registryPromise: Promise<ArtifactViewHandlerRegistry> | null = null;

/** Memoized across requests; the module set is fixed at build time. */
export function loadArtifactViewHandlerRegistry(): Promise<ArtifactViewHandlerRegistry> {
  registryPromise ??= collectArtifactViewHandlers({ onWarn: logWarning })
    .then(createArtifactViewHandlerRegistry)
    .catch((error) => {
      registryPromise = null;
      logger.error("artifact_view_handler_registry_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return EMPTY_ARTIFACT_VIEW_HANDLER_REGISTRY;
    });
  return registryPromise;
}
