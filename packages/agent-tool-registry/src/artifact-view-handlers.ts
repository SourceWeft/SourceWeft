import type {
  ArtifactViewHandler,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";
import { BUILTIN_CAPABILITY_MODULES } from "./capability-modules";

/**
 * Read-side artifact handler collection.
 *
 * Registration is the declaration: every builtin capability module is asked for
 * its `createArtifactViewHandlers` factory (mirroring how the worker collects
 * `createDeliverablePipelines`), and the result is indexed by artifactType.
 * Nothing here — and nothing in the host that consumes it — names an individual
 * artifact type.
 */

type ArtifactViewModule = {
  createArtifactViewHandlers?: CreateArtifactViewHandlers;
};

export type ArtifactViewHandlerRegistry = {
  handlerFor: (artifactType: string | null | undefined) => ArtifactViewHandler | null;
};

export type ArtifactViewHandlerWarning =
  | { kind: "load_failed"; packageName: string; error: unknown }
  | { kind: "conflict"; artifactType: string };

export type CollectArtifactViewHandlersOptions = {
  readonly modules?: Record<string, () => Promise<unknown>>;
  readonly onWarn?: (warning: ArtifactViewHandlerWarning) => void;
};

export async function collectArtifactViewHandlers(
  options: CollectArtifactViewHandlersOptions = {},
): Promise<ArtifactViewHandler[]> {
  const modules = options.modules ?? BUILTIN_CAPABILITY_MODULES;
  const handlers: ArtifactViewHandler[] = [];
  for (const [packageName, loadModule] of Object.entries(modules)) {
    try {
      const module = (await loadModule()) as ArtifactViewModule;
      const contributed = (await module.createArtifactViewHandlers?.()) ?? [];
      handlers.push(...contributed);
    } catch (error) {
      options.onWarn?.({ kind: "load_failed", packageName, error });
    }
  }
  return handlers;
}

export function createArtifactViewHandlerRegistry(
  handlers: readonly ArtifactViewHandler[],
  options: { readonly onWarn?: (warning: ArtifactViewHandlerWarning) => void } = {},
): ArtifactViewHandlerRegistry {
  const byType = new Map<string, ArtifactViewHandler>();
  for (const handler of handlers) {
    if (byType.has(handler.artifactType)) {
      options.onWarn?.({ kind: "conflict", artifactType: handler.artifactType });
      continue;
    }
    byType.set(handler.artifactType, handler);
  }
  return {
    handlerFor: (artifactType) =>
      (artifactType ? byType.get(artifactType) : undefined) ?? null,
  };
}

export const EMPTY_ARTIFACT_VIEW_HANDLER_REGISTRY: ArtifactViewHandlerRegistry = {
  handlerFor: () => null,
};
