import type { VideoPresentationDraftPayload } from "@sourceweft/contracts/video-presentation";
import { canonicalFileTreeDigest } from "./common";

export const VIDEO_PRESENTATION_VALIDATOR_VERSION = "video-validator";
export const VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION =
  "video-presentation-validation";
export const VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION =
  "video-presentation-load";

export type VideoValidationResourceBytes = {
  readonly identity: `asset:${string}` | `audio:${number}`;
  readonly bytes: Uint8Array;
};

function normalizedResource(
  resource:
    | VideoPresentationDraftPayload["assets"][number]["resource"]
    | VideoPresentationDraftPayload["audioTracks"][number]["resource"],
) {
  return resource.kind === "committed"
    ? {
        kind: resource.kind,
        resourceHandle: resource.resourceHandle,
        contentDigest: resource.contentDigest,
        contentType: resource.contentType,
      }
    : {
        kind: resource.kind,
        contentDigest: resource.contentDigest,
        contentType: resource.contentType,
      };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

/**
 * Path-insensitive semantic identity for the exact normalized draft and bytes.
 * Sandbox paths and WIP blob references are transport locators, not content.
 */
export function buildVideoValidationInputDigest(input: {
  readonly draft: VideoPresentationDraftPayload;
  readonly resources: readonly VideoValidationResourceBytes[];
}) {
  const normalizedDraft = {
    ...input.draft,
    slides: [...input.draft.slides].sort(
      (left, right) => left.slideNumber - right.slideNumber,
    ),
    sceneModules: [...input.draft.sceneModules].sort(
      (left, right) => left.slideNumber - right.slideNumber,
    ),
    audioTracks: [...input.draft.audioTracks]
      .sort((left, right) => left.slideNumber - right.slideNumber)
      .map((track) => ({
        ...track,
        resource: normalizedResource(track.resource),
      })),
    assets: [...input.draft.assets]
      .sort((left, right) => left.assetId.localeCompare(right.assetId))
      .map((asset) => ({
        ...asset,
        slideNumbers: [...asset.slideNumbers].sort(
          (left, right) => left - right,
        ),
        resource: normalizedResource(asset.resource),
      })),
    themeAssignments: [...input.draft.themeAssignments].sort(
      (left, right) => left.slideNumber - right.slideNumber,
    ),
  };
  return canonicalFileTreeDigest([
    {
      path: "draft.normalized.json",
      bytes: new TextEncoder().encode(
        JSON.stringify(canonicalJson(normalizedDraft)),
      ),
    },
    ...input.resources.map((resource) => ({
      path: resource.identity,
      bytes: resource.bytes,
    })),
  ]);
}
