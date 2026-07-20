/**
 * Write-side takeover contract for an artifact type — the mirror of
 * `ArtifactViewHandler` in `./artifacts.ts`.
 *
 * The read side already answers "how is this artifact served?" without the host
 * knowing any artifact type name: a capability registers a handler, and
 * registration *is* the declaration. This module is the same move for the other
 * direction, "how is this artifact written?".
 *
 * The model it fixes is deliberately not file-centric:
 *
 *   artifact = payload (required) + attachments (optional bytes) + preview
 *              (optional thumbnail)
 *
 * A file used to be the centre of gravity — the write path was reached through
 * `createFileArtifactRecord` / `createImageArtifactRecord` /
 * `createSlidesArtifactRecord`, each of which required a `storageBucket` and a
 * `storageKey`, so a type that produces no single downloadable file could not
 * use it at all. That is why `video_presentation` grew its own write path and
 * keeps `storageKey` NULL for its whole life. Here the payload is the required
 * part and bytes are optional, so a payload-only type is the ordinary case
 * rather than the exception.
 *
 * What a handler is allowed to do is narrow on purpose. It may reject a spec
 * (`validate`) and it may shape what lands in `payload_json` (`buildPayload`).
 * It may not touch storage, the row, ids, versioning or transactions — those
 * are the host's, exactly as on the read side.
 */

import type { ArtifactErrorCategory } from "./artifact-errors";
import {
  ARTIFACT_WRITE_ERROR_CODES,
  ArtifactError,
  isRecoverableArtifactErrorCategory,
} from "./artifact-errors";

/* -------------------------------------------------------------------------- */
/* The spec                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Bytes stored alongside an artifact.
 *
 * `role: "primary"` marks the one attachment that becomes the artifact row's
 * own `storage_bucket`/`storage_key` — what "download this artifact" serves.
 * Every other attachment is addressed by file name through the read side's
 * `resolveAsset`. At most one attachment may be primary; zero is legal and is
 * the normal case for a client-rendered type.
 */
export type ArtifactAttachment = {
  /** Display name; also the key the read side resolves assets by. */
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Defaults to `"asset"`. */
  readonly role?: "primary" | "asset";
  /**
   * Per-attachment ceiling. Left unset means "no type-specific ceiling"; a
   * handler that has one (an image artifact, a pptx deck) supplies it from
   * `ARTIFACT_LIMITS` rather than the host inventing a number per type.
   */
  readonly maxBytes?: number;
};

/**
 * A thumbnail. Unlike an attachment this is an *enhancement*: the host drops an
 * oversized preview rather than failing the write, matching the rule already
 * documented on `ARTIFACT_LIMITS.previewImageBytes`.
 */
export type ArtifactPreviewImage = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Defaults to `preview<ext-for-contentType>`. */
  readonly fileName?: string;
  readonly altText?: string | null;
};

/** Who the artifact belongs to. Never handler-visible; the host owns it. */
export type ArtifactWriteContext = {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
};

export type ArtifactPublishSpec = {
  readonly artifactType: string;
  readonly title: string;
  /** Free text that produced the artifact. Falls back to `title` when absent. */
  readonly prompt?: string;
  /** The artifact itself. Required — this is the part that is never optional. */
  readonly payload: Record<string, unknown>;
  readonly attachments?: readonly ArtifactAttachment[];
  readonly preview?: ArtifactPreviewImage;
  /**
   * Lets a caller ask for "the artifact for this request" rather than "a new
   * artifact". The host decides how to honour it; a handler never sees it.
   */
  readonly idempotency?: { readonly requestKey: string };
};

/* -------------------------------------------------------------------------- */
/* The writer, as its callers see it                                           */
/* -------------------------------------------------------------------------- */

export type ArtifactPublishResult = {
  readonly artifactId: string;
  readonly versionId: string;
  /**
   * True when an idempotency key resolved to an artifact that already existed,
   * so this call produced no new artifact, no new version and no new bytes.
   */
  readonly reused: boolean;
};

/**
 * The one-shot write, as a capability package sees it.
 *
 * The implementation is the host's (`ArtifactWriter` in the backend) and is not
 * importable from a capability package, so this is the port each producing tool
 * declares its dependency against — the same move `ArtifactStorage` makes for
 * object storage. It is deliberately narrower than the writer: a tool publishes,
 * it does not open, complete, fail, or version.
 */
export interface ArtifactPublisher {
  publishArtifact(input: {
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    /** Pre-allocated when the id had to exist before the work (billing keys). */
    readonly artifactId?: string;
  }): Promise<ArtifactPublishResult>;
}

/* -------------------------------------------------------------------------- */
/* The handler                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One rejected fact about a spec. A list rather than a thrown error so a
 * handler can report everything wrong with one spec in one pass, and so the
 * host — not the handler — owns how the failure is raised.
 */
export type ArtifactWriteIssue = {
  readonly code: string;
  readonly message: string;
  /** Omitted means "classify by code" via the shared table. */
  readonly category?: ArtifactErrorCategory;
  /** Dotted path into the spec, e.g. `payload.slides`. */
  readonly field?: string;
};

export type ArtifactWriteHandler = {
  readonly artifactType: string;
  /**
   * Type-specific validation, living in the package that produces the type.
   * Returning an empty list (or nothing) accepts the spec. The host runs its
   * own type-agnostic checks either way; a handler never has to restate them.
   */
  readonly validate?: (
    spec: ArtifactPublishSpec,
  ) => readonly ArtifactWriteIssue[] | null | undefined;
  /**
   * Last chance to shape what is persisted as `payload_json` — normalize,
   * drop transient fields, fold in attachment metadata. Returning nothing keeps
   * `spec.payload` as-is. It must stay pure: it runs inside the host's write
   * and may be re-run on a retry.
   */
  readonly buildPayload?: (
    spec: ArtifactPublishSpec,
  ) => Record<string, unknown> | null | undefined;
};

/** Factory a capability package exports so hosts can collect its handlers. */
export type CreateArtifactWriteHandlers = () =>
  | readonly ArtifactWriteHandler[]
  | Promise<readonly ArtifactWriteHandler[]>;

/* -------------------------------------------------------------------------- */
/* Type-agnostic spec checks                                                   */
/* -------------------------------------------------------------------------- */

const MAX_PRIMARY_ATTACHMENTS = 1;

export function attachmentRole(
  attachment: ArtifactAttachment,
): "primary" | "asset" {
  return attachment.role ?? "asset";
}

/**
 * The checks that hold for every artifact type, so no handler has to repeat
 * them: a title, a payload, non-empty attachments within their own ceiling,
 * unique file names, and at most one primary.
 *
 * Size is checked here and not at upload time on purpose — rejecting before any
 * byte is written is what keeps a failed write from leaving orphaned objects in
 * the bucket.
 */
export function validateArtifactPublishSpec(
  spec: ArtifactPublishSpec,
): ArtifactWriteIssue[] {
  const issues: ArtifactWriteIssue[] = [];
  const invalid = ARTIFACT_WRITE_ERROR_CODES.payloadInvalid;

  if (!spec.artifactType || spec.artifactType.trim().length === 0) {
    issues.push({
      code: invalid,
      field: "artifactType",
      message: "artifactType is required",
    });
  }
  if (!spec.title || spec.title.trim().length === 0) {
    issues.push({ code: invalid, field: "title", message: "title is required" });
  }
  if (
    !spec.payload ||
    typeof spec.payload !== "object" ||
    Array.isArray(spec.payload)
  ) {
    issues.push({
      code: invalid,
      field: "payload",
      message: "payload must be an object",
    });
  }

  const attachments = spec.attachments ?? [];
  const seenFileNames = new Set<string>();
  let primaryCount = 0;

  attachments.forEach((attachment, index) => {
    const field = `attachments[${index}]`;
    if (attachmentRole(attachment) === "primary") {
      primaryCount += 1;
    }
    const fileName = attachment.fileName?.trim() ?? "";
    if (fileName.length === 0) {
      issues.push({
        code: invalid,
        field: `${field}.fileName`,
        message: "attachment fileName is required",
      });
    } else if (seenFileNames.has(fileName)) {
      // Two attachments under one name means the read side's resolveAsset can
      // only ever reach one of them, and which one is upload order.
      issues.push({
        code: invalid,
        field: `${field}.fileName`,
        message: `duplicate attachment fileName: ${fileName}`,
      });
    } else {
      seenFileNames.add(fileName);
    }

    if (attachment.bytes.byteLength === 0) {
      issues.push({
        code: ARTIFACT_WRITE_ERROR_CODES.attachmentEmpty,
        field,
        message: `attachment ${fileName || index} is empty`,
      });
    } else if (
      typeof attachment.maxBytes === "number" &&
      attachment.bytes.byteLength > attachment.maxBytes
    ) {
      issues.push({
        code: ARTIFACT_WRITE_ERROR_CODES.attachmentTooLarge,
        field,
        message: `attachment ${fileName || index} is ${attachment.bytes.byteLength} bytes, over the ${attachment.maxBytes} byte limit`,
      });
    }
  });

  if (primaryCount > MAX_PRIMARY_ATTACHMENTS) {
    issues.push({
      code: invalid,
      field: "attachments",
      message: `at most ${MAX_PRIMARY_ATTACHMENTS} attachment may have role "primary"; received ${primaryCount}`,
    });
  }

  return issues;
}

/** The attachment that becomes the row's own stored file, if any. */
export function primaryArtifactAttachment(
  spec: ArtifactPublishSpec,
): ArtifactAttachment | null {
  return (
    (spec.attachments ?? []).find(
      (attachment) => attachmentRole(attachment) === "primary",
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Issues -> the one error vocabulary                                          */
/* -------------------------------------------------------------------------- */

/**
 * Collapse issues into a single `ArtifactError`. The reported code and category
 * come from the *least* recoverable issue: telling a caller "fix your input"
 * when one of the problems is a dead dependency sends it into a retry loop, the
 * failure mode `artifact-errors.ts` exists to prevent.
 */
export function artifactErrorFromIssues(
  issues: readonly ArtifactWriteIssue[],
  fallbackCode: string = ARTIFACT_WRITE_ERROR_CODES.payloadInvalid,
): ArtifactError | null {
  if (issues.length === 0) {
    return null;
  }
  const worst =
    issues.find(
      (issue) =>
        issue.category !== undefined &&
        !isRecoverableArtifactErrorCategory(issue.category),
    ) ?? issues[0]!;
  return new ArtifactError({
    code: worst.code || fallbackCode,
    ...(worst.category ? { category: worst.category } : {}),
    message: issues
      .map((issue) =>
        issue.field ? `${issue.field}: ${issue.message}` : issue.message,
      )
      .join("; "),
    ...(worst.field ? { details: worst.field } : {}),
  });
}

/**
 * Run the host's checks and then the handler's, in that order. The host's come
 * first so a handler never receives a spec that is structurally broken.
 */
export function collectArtifactWriteIssues(
  spec: ArtifactPublishSpec,
  handler?: ArtifactWriteHandler | null,
): ArtifactWriteIssue[] {
  const issues = validateArtifactPublishSpec(spec);
  if (issues.length > 0) {
    return issues;
  }
  return [...(handler?.validate?.(spec) ?? [])];
}

/** `buildPayload` if the handler has one, `spec.payload` otherwise. */
export function buildArtifactWritePayload(
  spec: ArtifactPublishSpec,
  handler?: ArtifactWriteHandler | null,
): Record<string, unknown> {
  return handler?.buildPayload?.(spec) ?? spec.payload;
}
