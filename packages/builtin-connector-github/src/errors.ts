/** Error thrown by this package's pure helpers and its API/tool layers.
 * `apps/backend/src/modules/connectors/errors.ts` (`toConnectorError`) copies
 * `statusCode`, `code`, `message` and `details` verbatim onto a
 * `ConnectorError`, so a caller that needs the browser to know how long to
 * wait must set `details.retryAfterSeconds`. */
export class GithubAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GithubAdapterError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
