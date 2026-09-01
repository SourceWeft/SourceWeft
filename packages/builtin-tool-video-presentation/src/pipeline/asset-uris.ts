import ts from "typescript";
import type { VideoPresentationRenderableProject } from "@sourceweft/contracts/video-presentation";

export const VIDEO_PRESENTATION_ASSET_URI_PREFIX = "sourceweft-asset:";

export function videoPresentationAssetUri(assetId: string) {
  return `${VIDEO_PRESENTATION_ASSET_URI_PREFIX}${assetId}`;
}

function materializeSceneAssetUris(
  code: string,
  sourceUrlByIdentity: ReadonlyMap<string, string>,
) {
  const sourceFile = ts.createSourceFile(
    "VideoScene.tsx",
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      const sourceUrl = sourceUrlByIdentity.get(node.text);
      if (sourceUrl) {
        edits.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          replacement: JSON.stringify(sourceUrl),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        `${current.slice(0, edit.start)}${edit.replacement}${current.slice(edit.end)}`,
      code,
    );
}

/** Materialize stable scene asset identities only inside the trusted project. */
export function materializeVideoPresentationAssetUris(
  payload: VideoPresentationRenderableProject,
): VideoPresentationRenderableProject {
  const sourceUrlByIdentity = new Map(
    payload.assets.flatMap((asset) =>
      asset.sourceUrl
        ? [[videoPresentationAssetUri(asset.assetId), asset.sourceUrl] as const]
        : [],
    ),
  );
  if (sourceUrlByIdentity.size === 0) return payload;
  return {
    ...payload,
    sceneModules: payload.sceneModules.map((scene) => ({
      ...scene,
      code: materializeSceneAssetUris(scene.code, sourceUrlByIdentity),
    })),
  };
}
