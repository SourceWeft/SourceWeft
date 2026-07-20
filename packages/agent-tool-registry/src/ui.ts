/**
 * The artifact-UI index.
 *
 * Registering a capability's artifact UI is one line in `ARTIFACT_UI_MODULES`
 * below — the generic render layer in the app never learns a capability name, a
 * payload shape, or an ordering rule.
 *
 * Static imports, not the lazy `import()` map in `capability-modules.ts`: these
 * are browser components that all end up in the same client bundle regardless,
 * and being static lets both resolvers stay synchronous, so the hosts keep
 * rendering inline instead of growing Suspense boundaries.
 *
 * Kept out of the package's main entry on purpose. This subpath is the only
 * place React enters the registry, so server consumers that import
 * `@sourceweft/agent-tool-registry` never pull React types or code.
 */
import type {
  ArtifactBlockProps,
  ArtifactPreviewContext,
  ArtifactPreviewResult,
  ArtifactUiModule,
} from "@sourceweft/contracts/artifact-ui";
import type { ComponentType } from "react";
import { generateImageArtifactUi } from "@sourceweft/builtin-tool-generate-image/ui";
import { publishArtifactArtifactUi } from "@sourceweft/builtin-tool-publish-artifact/ui";
import { videoPresentationArtifactUi } from "@sourceweft/builtin-tool-video-presentation/ui";

/** Every capability that renders its own artifacts. Add one line per capability. */
export const ARTIFACT_UI_MODULES: readonly ArtifactUiModule[] = [
  generateImageArtifactUi,
  publishArtifactArtifactUi,
  videoPresentationArtifactUi,
];

function indexModules(modules: readonly ArtifactUiModule[]) {
  const blocks = new Map<string, ComponentType<ArtifactBlockProps>>();
  const previews = new Map<string, ArtifactUiModule>();

  for (const module of modules) {
    if (module.renderAs) {
      if (!module.Block) {
        throw new Error(
          `Artifact UI module "${module.id}" declares renderAs "${module.renderAs}" but has no Block.`,
        );
      }
      const claimed = blocks.get(module.renderAs);
      if (claimed) {
        throw new Error(
          `Artifact UI renderAs "${module.renderAs}" is claimed by more than one module (conflict on "${module.id}").`,
        );
      }
      blocks.set(module.renderAs, module.Block);
    } else if (module.Block) {
      throw new Error(
        `Artifact UI module "${module.id}" has a Block but no renderAs to reach it by.`,
      );
    }

    for (const artifactType of module.artifactTypes ?? []) {
      if (!module.preview) {
        throw new Error(
          `Artifact UI module "${module.id}" claims artifactType "${artifactType}" but has no preview().`,
        );
      }
      const owner = previews.get(artifactType);
      if (owner) {
        throw new Error(
          `Artifact type "${artifactType}" is claimed by both "${owner.id}" and "${module.id}".`,
        );
      }
      previews.set(artifactType, module);
    }

    if (module.preview && (module.artifactTypes ?? []).length === 0) {
      throw new Error(
        `Artifact UI module "${module.id}" has a preview() but claims no artifactTypes.`,
      );
    }
  }

  return { blocks, previews };
}

const { blocks: BLOCKS_BY_RENDER_AS, previews: PREVIEWS_BY_ARTIFACT_TYPE } =
  indexModules(ARTIFACT_UI_MODULES);

/**
 * Message-stream path: the component for a capability's `renderAs` token, or
 * null when no capability claims it.
 */
export function resolveArtifactBlock(
  renderAs: string | null | undefined,
): ComponentType<ArtifactBlockProps> | null {
  return renderAs ? (BLOCKS_BY_RENDER_AS.get(renderAs) ?? null) : null;
}

/**
 * Preview-panel path: hand the stored artifact row to its owning capability and
 * let it decide whether it can render this variant. A capability that owns the
 * type but declines the row returns null, and the host falls through.
 */
export function resolveArtifactPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult | null {
  const module = PREVIEWS_BY_ARTIFACT_TYPE.get(context.artifact.artifactType);
  return module?.preview?.(context) ?? null;
}

export type {
  ArtifactBlockProps,
  ArtifactPreviewContext,
  ArtifactPreviewResult,
  ArtifactUiModule,
} from "@sourceweft/contracts/artifact-ui";
export {
  artifactRenderHost,
  configureArtifactRenderHost,
  type ArtifactRenderHost,
} from "@sourceweft/contracts/artifact-ui";

/**
 * Image tool-output readers, re-exported for the host's generic tool-card
 * labelling. The decoding itself stays in the capability package.
 */
export {
  getGeneratedImagePrompt,
  getGeneratedImageStatus,
  getGeneratedImageTitle,
  resolveGeneratedImageArtifactRef,
} from "@sourceweft/builtin-tool-generate-image/ui";
