export type McpErrorMetadata = {
  details?: Record<string, unknown>;
  sourceRef?: Record<string, unknown>;
  recoverable?: boolean;
};

export class McpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly sourceRef?: Record<string, unknown>;
  readonly recoverable?: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    detailsOrMetadata?: Record<string, unknown> | McpErrorMetadata,
  ) {
    super(message);
    this.name = "McpError";
    this.statusCode = statusCode;
    this.code = code;
    if (detailsOrMetadata && "sourceRef" in detailsOrMetadata) {
      const metadata = detailsOrMetadata as McpErrorMetadata;
      this.details = metadata.details;
      this.sourceRef = metadata.sourceRef;
      this.recoverable = metadata.recoverable;
    } else {
      this.details = detailsOrMetadata as Record<string, unknown> | undefined;
    }
  }
}

export function isMcpError(error: unknown): error is McpError {
  return error instanceof McpError;
}
