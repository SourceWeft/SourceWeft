import { buildParsedDocument } from "./utils";
import type {
  DocumentParseProvider,
  ProviderPendingToken,
  ProviderParseInput,
} from "./types";
import type { DocumentParseMode } from "../../../content/types";
import {
  downloadPdf2MarkdownResult,
  getPdf2MarkdownTaskResult,
  getPdf2MarkdownTaskStatus,
  submitPdf2MarkdownAsync,
} from "./pdf2markdown-client";
import { extractPdf2MarkdownResult } from "@sourceweft/builtin-document-parsers";
import { isSupportedImageMimeType } from "./utils";
import { normalizeImageForPdf2Markdown } from "./image-normalizer";

function parseMode(mimeType: string) {
  return (
    isSupportedImageMimeType(mimeType) ? "image_ocr" : "ocr_pdf"
  ) as DocumentParseMode;
}

function normalizeTaskStatus(status: string) {
  return status.trim().toLowerCase();
}

function isTerminalFailureStatus(status: string) {
  return ["failed", "error", "cancelled", "canceled"].includes(
    normalizeTaskStatus(status),
  );
}

export const pdf2MarkdownProvider: DocumentParseProvider = {
  id: "pdf2markdown",
  supports(mimeType) {
    return mimeType === "application/pdf" || isSupportedImageMimeType(mimeType);
  },
  async start(input: ProviderParseInput) {
    const normalized = await normalizeImageForPdf2Markdown({
      content: input.content,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });
    const response = await submitPdf2MarkdownAsync({
      content: normalized.content,
      filename: normalized.fileName,
      metadata: {
        sourceId: input.sourceId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
      },
    });
    const taskId = response.data.task_id;
    const token: ProviderPendingToken = {
      backendId: "pdf2markdown",
      taskId,
      sourceId: input.sourceId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      parsingConfig: input.config,
      attempt: 0,
    };

    return {
      kind: "pending",
      token,
      diagnostics: {
        metadata: {
          documentParseProviderResolved: "pdf2markdown",
          documentParseProvider: "pdf2markdown",
          documentParseBackend: "pdf2markdown",
          documentParseMode: parseMode(input.mimeType),
          providerTaskId: taskId,
          providerStatus: response.data.status,
          providerAttempts: 0,
          providerUpdatedAt: new Date().toISOString(),
          providerInputMimeType: normalized.mimeType,
          providerOriginalMimeType: normalized.originalMimeType,
          providerOriginalFileName: normalized.originalFileName,
          pageCount: response.data.page_count,
        },
      },
    };
  },
  async resume(token: ProviderPendingToken, content: Buffer) {
    const status = await getPdf2MarkdownTaskStatus(token.taskId);
    const attempt = token.attempt + 1;
    const normalizedStatus = normalizeTaskStatus(status.status);

    if (isTerminalFailureStatus(status.status)) {
      throw new Error(
        `PDF2Markdown task ${token.taskId} failed with status: ${status.status}`,
      );
    }

    if (normalizedStatus !== "completed") {
      return {
        kind: "pending",
        token: { ...token, attempt },
        diagnostics: {
          metadata: {
            documentParseProviderResolved: "pdf2markdown",
            documentParseProvider: "pdf2markdown",
            documentParseBackend: "pdf2markdown",
            documentParseMode: parseMode(token.mimeType),
            providerTaskId: token.taskId,
            providerStatus: status.status,
            providerAttempts: attempt,
            providerUpdatedAt: new Date().toISOString(),
            pageCount: status.page_count,
          },
        },
      };
    }

    const result = await getPdf2MarkdownTaskResult(token.taskId);
    if (!result.result?.url) {
      throw new Error("PDF2Markdown task completed without a result URL");
    }

    const resultJson = await downloadPdf2MarkdownResult(result.result.url);
    const extracted = extractPdf2MarkdownResult(resultJson);
    const document = await buildParsedDocument({
      parseInput: {
        fileName: token.fileName,
        mimeType: token.mimeType,
        fileSize: token.fileSize,
        content,
        config: token.parsingConfig,
      },
      content: extracted.content,
      pages: extracted.pages,
      metadata: {
        pageCount: extracted.pageCount ?? result.page_count,
        documentParseProviderResolved: "pdf2markdown",
        documentParseProvider: "pdf2markdown",
        documentParseBackend: "pdf2markdown",
        documentParseMode: parseMode(token.mimeType),
        providerTaskId: token.taskId,
        providerStatus: "completed",
        providerAttempts: attempt,
        providerUpdatedAt: new Date().toISOString(),
      },
    });

    return {
      kind: "completed",
      document,
      diagnostics: {
        metadata: document.metadata,
      },
    };
  },
};
