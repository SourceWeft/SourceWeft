import {
  ConnectorItemSkipError,
  type ConnectorActionInput,
  type ConnectorActionResult,
  type ConnectorAdapter,
  type ConnectorDiscoverInput,
  type ConnectorDiscoveryPage,
  type ConnectorExtractInput,
  type ConnectorExtractedContent,
  type ConnectorExtractedText,
  type ConnectorItem,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendGoogleDriveManifest } from "./backend-manifest";
import {
  GOOGLE_DRIVE_PICKER_MIME_TYPES,
  exportedFileName,
  resolveDriveFileHandling,
} from "./file-types";
import {
  GoogleDriveAdapterError,
  assertDriveFileId,
  createDriveClient,
  type DriveFile,
} from "./drive-client";
import { parseProjectNumber } from "./host-services";

export { GoogleDriveAdapterError } from "./drive-client";

const PAGE_SIZE = 50;

export type GoogleDriveAdapterConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  pickerApiKey: string;
  fetcher?: typeof fetch;
};

function toItem(file: DriveFile): ConnectorItem {
  const fileId = assertDriveFileId(file.id);
  const driveMimeType = typeof file.mimeType === "string" ? file.mimeType : "";
  const handling = resolveDriveFileHandling(driveMimeType);
  const size =
    typeof file.size === "string" && file.size.trim() !== ""
      ? Number(file.size)
      : null;
  return {
    externalId: `file:${fileId}`,
    externalUri: typeof file.webViewLink === "string" ? file.webViewLink : null,
    title: typeof file.name === "string" ? file.name : "",
    // The MIME type of the content the platform receives: the handling's
    // itemMimeType (export MIME for native files, original for downloads), or
    // the original Drive MIME for an unsupported file that has no handling.
    mimeType:
      handling.kind === "unsupported" ? driveMimeType : handling.itemMimeType,
    sizeBytes: size !== null && Number.isFinite(size) ? size : null,
    externalUpdatedAt:
      typeof file.modifiedTime === "string"
        ? new Date(file.modifiedTime)
        : null,
    contentHash:
      typeof file.md5Checksum === "string" && file.md5Checksum
        ? `md5:${file.md5Checksum}`
        : null,
    metadata: { driveFileId: fileId, driveMimeType },
  };
}

function selectedFileIds(config: Record<string, unknown>): string[] {
  return Array.isArray(config.fileIds)
    ? config.fileIds.filter((id): id is string => typeof id === "string")
    : [];
}

/** Reads the resume offset out of `cursor.continuation.offset` (default 0). */
function readOffset(cursor: ConnectorDiscoverInput["cursor"]): number {
  const continuation =
    cursor && typeof cursor === "object" && !Array.isArray(cursor)
      ? (cursor as Record<string, unknown>).continuation
      : null;
  const offset =
    continuation && typeof continuation === "object"
      ? (continuation as Record<string, unknown>).offset
      : null;
  return typeof offset === "number" && Number.isInteger(offset) && offset > 0
    ? offset
    : 0;
}

function metadataField(item: ConnectorItem, key: string): unknown {
  const metadata = item.metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)[key]
    : undefined;
}

export function createGoogleDriveConnectorAdapter(
  config: GoogleDriveAdapterConfig,
): ConnectorAdapter {
  const fetcher = config.fetcher ?? fetch;
  const client = createDriveClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetcher,
  });
  const redirectUri = `${config.baseUrl}/v1/connectors/oauth/google_drive/callback`;

  async function* pages(
    input: ConnectorDiscoverInput,
  ): AsyncIterable<ConnectorDiscoveryPage> {
    const fileIds = selectedFileIds(input.config);
    // Validate the whole selection before any request leaves the process.
    for (const id of fileIds) assertDriveFileId(id);
    if (fileIds.length === 0) {
      yield {
        items: [],
        continuation: null,
        checkpoint: null,
        complete: true,
        reconcileMissing: true,
      };
      return;
    }
    let offset = readOffset(input.cursor);
    while (true) {
      const slice = fileIds.slice(offset, offset + PAGE_SIZE);
      const items: ConnectorItem[] = [];
      for (const id of slice) {
        const file = await client.getFileMetadata(input.accessToken, id);
        if (file) items.push(toItem(file));
      }
      const nextOffset = offset + PAGE_SIZE;
      const complete = nextOffset >= fileIds.length;
      if (complete) {
        yield {
          items,
          continuation: null,
          checkpoint: null,
          complete: true,
          reconcileMissing: true,
        };
        return;
      }
      yield {
        items,
        continuation: { offset: nextOffset },
        complete: false,
        reconcileMissing: false,
      };
      offset = nextOffset;
    }
  }

  return {
    capabilityId: "sourceweft/google-drive",
    getManifest() {
      return toBackendGoogleDriveManifest({
        clientId: config.clientId,
        redirectUri,
      });
    },
    async exchangeOAuthCode(
      input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      const token = await client.exchangeAuthorizationCode(
        input.code,
        input.redirectUri,
      );
      const user = await client.getAbout(token.accessToken);
      return {
        ...token,
        providerAccountId: user.permissionId ?? null,
        providerAccountEmail: user.emailAddress ?? null,
        displayName: user.displayName ?? user.emailAddress ?? null,
      };
    },
    async refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      return client.refreshAccessToken(input.refreshToken);
    },
    async *discover(
      input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorItem> {
      for await (const page of pages(input)) {
        for (const item of page.items) yield item;
      }
    },
    discoverPages(
      input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorDiscoveryPage> {
      return pages(input);
    },
    async extract(
      input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      const item = input.item;
      const fileId = assertDriveFileId(metadataField(item, "driveFileId"));
      const driveMimeTypeValue = metadataField(item, "driveMimeType");
      const driveMimeType =
        typeof driveMimeTypeValue === "string" ? driveMimeTypeValue : "";
      const handling = resolveDriveFileHandling(driveMimeType);
      if (handling.kind === "unsupported") {
        throw new ConnectorItemSkipError("unsupported_type");
      }
      if (handling.kind === "export_text") {
        const text = await client.exportText(
          input.accessToken,
          fileId,
          handling.exportMimeType,
        );
        if (!text.trim()) {
          throw new ConnectorItemSkipError("empty_content");
        }
        const content: ConnectorExtractedText = { item, contentText: text };
        if (handling.asMarkdown) content.markdown = text;
        return content;
      }
      if (handling.kind === "export_file") {
        const exportMimeType = handling.exportMimeType;
        const extension = handling.extension;
        return {
          item,
          file: {
            fileName: exportedFileName(item.title, extension),
            mimeType: exportMimeType,
            sizeBytes: null,
            download: ({ maxBytes }: { maxBytes: number }) =>
              client.exportBytes(
                input.accessToken,
                fileId,
                exportMimeType,
                maxBytes,
              ),
          },
        };
      }
      // handling.kind === "download": the stored bytes are returned as-is.
      return {
        item,
        file: {
          fileName: item.title,
          mimeType: handling.itemMimeType,
          sizeBytes: item.sizeBytes,
          download: ({ maxBytes }: { maxBytes: number }) =>
            client.downloadBytes(input.accessToken, fileId, maxBytes),
        },
      };
    },
    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      if (input.actionType === "google_drive.picker.config") {
        // Returns only the browser key and the project number; no secret and
        // no access token ever leave through an action result.
        return {
          result: {
            appId: parseProjectNumber(config.clientId),
            developerKey: config.pickerApiKey,
            mimeTypes: [...GOOGLE_DRIVE_PICKER_MIME_TYPES],
          },
        };
      }
      throw new GoogleDriveAdapterError(
        400,
        "GOOGLE_DRIVE_UNSUPPORTED_ACTION",
        "Unsupported Google Drive action",
      );
    },
  };
}
