import type {
  ArtifactWriteHandler,
  CreateArtifactWriteHandlers,
} from "@sourceweft/contracts";
import { BUILTIN_CAPABILITY_MODULES } from "./capability-modules";

/**
 * Write-side artifact handler collection — the mirror of
 * `./artifact-view-handlers.ts`, deliberately the same shape.
 *
 * Registration is the declaration: every builtin capability module is asked for
 * its `createArtifactWriteHandlers` factory and the result is indexed by
 * artifactType. Nothing here — and nothing in the host that consumes it — names
 * an individual artifact type, so adding a type is a handler in its own package
 * plus one line in `capability-modules.ts`.
 *
 * A type with no registered handler is not an error: the host's type-agnostic
 * write still applies. That is the difference from the read side, where the
 * absence of a handler is itself the answer ("the client cannot render this").
 */

type ArtifactWriteModule = {
  createArtifactWriteHandlers?: CreateArtifactWriteHandlers;
};

export type ArtifactWriteHandlerRegistry = {
  handlerFor: (
    artifactType: string | null | undefined,
  ) => ArtifactWriteHandler | null;
};

export type ArtifactWriteHandlerWarning =
  | { kind: "load_failed"; packageName: string; error: unknown }
  | { kind: "conflict"; artifactType: string };

export type CollectArtifactWriteHandlersOptions = {
  readonly modules?: Record<string, () => Promise<unknown>>;
  readonly onWarn?: (warning: ArtifactWriteHandlerWarning) => void;
};

export async function collectArtifactWriteHandlers(
  options: CollectArtifactWriteHandlersOptions = {},
): Promise<ArtifactWriteHandler[]> {
  const modules = options.modules ?? BUILTIN_CAPABILITY_MODULES;
  const handlers: ArtifactWriteHandler[] = [];
  for (const [packageName, loadModule] of Object.entries(modules)) {
    try {
      const module = (await loadModule()) as ArtifactWriteModule;
      const contributed = (await module.createArtifactWriteHandlers?.()) ?? [];
      handlers.push(...contributed);
    } catch (error) {
      options.onWarn?.({ kind: "load_failed", packageName, error });
    }
  }
  return handlers;
}

export function createArtifactWriteHandlerRegistry(
  handlers: readonly ArtifactWriteHandler[],
  options: {
    readonly onWarn?: (warning: ArtifactWriteHandlerWarning) => void;
  } = {},
): ArtifactWriteHandlerRegistry {
  const byType = new Map<string, ArtifactWriteHandler>();
  for (const handler of handlers) {
    if (byType.has(handler.artifactType)) {
      // First registration wins, same as the read side: a later duplicate is a
      // packaging mistake, and silently letting it take over would make which
      // handler validates an artifact depend on module iteration order.
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

export const EMPTY_ARTIFACT_WRITE_HANDLER_REGISTRY: ArtifactWriteHandlerRegistry =
  {
    handlerFor: () => null,
  };
