export class PreviewAccessError extends Error {
  readonly statusCode = 403;
  readonly code = "PREVIEW_ACCESS_DENIED";

  constructor() {
    super("This preview feature is not available for this user");
    this.name = "PreviewAccessError";
  }
}
