import { useEffect, useState } from "react";
import {
  artifactVersionMediaProjectionSchema,
  type ArtifactVersionMediaProjection,
} from "@sourceweft/contracts";
import { buildArtifactVersionMediaProxyUrl } from "@sourceweft/contracts/artifact-urls";
import { contentClient } from "../../../../../lib/sdk";

export function withArtifactVersionMediaProxyUrls(
  media: ArtifactVersionMediaProjection,
  workspaceId: string,
): ArtifactVersionMediaProjection {
  const routeInput = {
    workspaceId,
    artifactId: media.artifactId,
    artifactVersionId: media.artifactVersionId,
  };
  return {
    ...media,
    media: {
      ...media.media,
      url: buildArtifactVersionMediaProxyUrl({
        ...routeInput,
        resource: "video",
      }),
      downloadUrl: buildArtifactVersionMediaProxyUrl({
        ...routeInput,
        resource: "video",
        download: true,
      }),
    },
    coverImage: media.coverImage
      ? {
          ...media.coverImage,
          url: buildArtifactVersionMediaProxyUrl({
            ...routeInput,
            resource: "cover",
          }),
        }
      : null,
  };
}

export function useArtifactVersionMedia(input: {
  workspaceId?: string | null;
  artifactId: string;
  artifactVersionId: string;
  enabled: boolean;
}) {
  const identity = input.workspaceId
    ? `${input.workspaceId}\u0000${input.artifactId}\u0000${input.artifactVersionId}`
    : null;
  const [state, setState] = useState<{
    identity: string | null;
    media?: ArtifactVersionMediaProjection;
    error: string | null;
  }>({ identity, error: null });
  const current =
    state.identity === identity
      ? state
      : { identity, error: null as string | null };

  useEffect(() => {
    if (!input.enabled || !input.workspaceId || !identity) {
      setState({ identity, error: null });
      return;
    }
    const workspaceId = input.workspaceId;
    let cancelled = false;
    setState({ identity, error: null });
    void contentClient
      .getArtifactVersionMedia(
        workspaceId,
        input.artifactId,
        input.artifactVersionId,
      )
      .then((result) => {
        if (cancelled) return;
        const parsed = artifactVersionMediaProjectionSchema.safeParse(
          result.media,
        );
        if (
          !parsed.success ||
          parsed.data.artifactId !== input.artifactId ||
          parsed.data.artifactVersionId !== input.artifactVersionId
        ) {
          setState({
            identity,
            error: "Artifact version details did not match the request.",
          });
          return;
        }
        setState({
          identity,
          error: null,
          media: withArtifactVersionMediaProxyUrls(parsed.data, workspaceId),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            identity,
            error: "Artifact version could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    identity,
    input.artifactId,
    input.artifactVersionId,
    input.enabled,
    input.workspaceId,
  ]);

  return {
    error: current.error,
    media: current.media,
    loading:
      input.enabled && Boolean(identity) && !current.error && !current.media,
  };
}
