import {
  ArtifactRecordTransportError,
  artifactRecordErrorCodeFromApi,
  type ArtifactRecordsTransport,
} from "@sourceweft/contracts/artifact-records";
import { HttpClientError, type ContentClient } from "@sourceweft/sdk";

/** The page sees short codes only; anything unrecognized is "unavailable". */
async function translated<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HttpClientError)
      throw new ArtifactRecordTransportError(
        artifactRecordErrorCodeFromApi(error.code),
        error.message,
      );
    throw new ArtifactRecordTransportError(
      "unavailable",
      "Storage is temporarily unavailable",
    );
  }
}

/** Signed-in storage for one rendered version, with approval and consent. */
export function createAppArtifactRecordsTransport(
  client: ContentClient,
  input: { workspaceId: string; artifactId: string; artifactVersionId: string },
): ArtifactRecordsTransport {
  const { workspaceId, artifactId, artifactVersionId } = input;
  return {
    execute: (operation) =>
      translated(() =>
        client.executeArtifactRecord(workspaceId, artifactId, {
          versionId: artifactVersionId,
          operation,
        }),
      ),
    status: () =>
      translated(() =>
        client.getArtifactRecordsStatus(
          workspaceId,
          artifactId,
          artifactVersionId,
        ),
      ),
    approveShared: () =>
      translated(async () => {
        await client.approveArtifactSharedRecords(
          workspaceId,
          artifactId,
          artifactVersionId,
        );
      }),
    revokeShared: () =>
      translated(async () => {
        await client.revokeArtifactSharedRecords(
          workspaceId,
          artifactId,
          artifactVersionId,
        );
      }),
    grantSharedConsent: () =>
      translated(async () => {
        await client.grantArtifactSharedRecordsConsent(
          workspaceId,
          artifactId,
          artifactVersionId,
        );
      }),
    reportNavigation: () =>
      translated(async () => {
        await client.reportArtifactPageNavigation(
          workspaceId,
          artifactId,
          artifactVersionId,
        );
      }),
  };
}

/** Public share storage: read-only shared collections, bound to the token. */
export function createPublicArtifactRecordsTransport(
  client: ContentClient,
  token: string,
): ArtifactRecordsTransport {
  return {
    execute: (operation) =>
      translated(() => client.executePublicArtifactRecord(token, operation)),
  };
}
