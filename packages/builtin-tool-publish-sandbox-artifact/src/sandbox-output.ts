import { PptxOutputError } from "./schemas";

/**
 * Download and validate a PPTX file from a Daytona sandbox.
 *
 * Returns a Buffer of the raw PPTX bytes after basic validation.
 */
export async function downloadPptxFromSandbox(input: {
  provider: {
    downloadFile(input: {
      providerSandboxId: string;
      sandboxPath: string;
    }): Promise<Buffer>;
  };
  providerSandboxId: string;
  sandboxPath: string;
  maxBytes: number;
}): Promise<Buffer> {
  // Validate extension
  if (!input.sandboxPath.toLowerCase().endsWith(".pptx")) {
    throw new PptxOutputError(
      "PPTX_OUTPUT_INVALID_EXTENSION",
      `path must end with .pptx: ${input.sandboxPath}`,
    );
  }

  let raw: Buffer;
  try {
    raw = await input.provider.downloadFile({
      providerSandboxId: input.providerSandboxId,
      sandboxPath: input.sandboxPath,
    });
  } catch (error) {
    throw new PptxOutputError(
      "PPTX_OUTPUT_NOT_FOUND",
      `sandbox download failed for ${input.sandboxPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (raw.byteLength > input.maxBytes) {
    throw new PptxOutputError(
      "PPTX_OUTPUT_TOO_LARGE",
      `${raw.byteLength} bytes exceeds limit of ${input.maxBytes} bytes`,
    );
  }

  // Basic ZIP/OOXML validation
  if (raw.byteLength < 4 || raw[0] !== 0x50 || raw[1] !== 0x4b) {
    throw new PptxOutputError(
      "PPTX_PACKAGE_INVALID",
      "file is not a valid ZIP archive (missing PK magic bytes)",
    );
  }

  return raw;
}

/**
 * Validate that a PPTX binary (ZIP) contains the minimal required
 * OOXML entries.
 */
export function validatePptxPackage(buffer: Buffer): void {
  if (buffer.byteLength < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new PptxOutputError(
      "PPTX_PACKAGE_INVALID",
      "file is not a valid ZIP archive (missing PK magic bytes)",
    );
  }

  // Quick structural check: the file must be at least large enough to
  // contain a minimal ZIP local file header + a few OOXML parts.
  // Full OOXML conformance is not checked here — pptxgenjs and
  // LibreOffice output both pass this guard reliably.
  const text = buffer.toString("latin1");
  if (!text.includes("[Content_Types].xml")) {
    throw new PptxOutputError(
      "PPTX_PACKAGE_INVALID",
      "missing [Content_Types].xml",
    );
  }
  if (!text.includes("ppt/presentation.xml")) {
    throw new PptxOutputError(
      "PPTX_PACKAGE_INVALID",
      "missing ppt/presentation.xml",
    );
  }
  if (!text.includes("ppt/slides/slide")) {
    throw new PptxOutputError(
      "PPTX_PACKAGE_INVALID",
      "missing ppt/slides/slide*.xml",
    );
  }
}
