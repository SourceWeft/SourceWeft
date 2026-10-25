import { z } from "zod";

/**
 * Persistent records an HTML artifact page reads and writes through the host.
 *
 * The page never talks to the network: it posts requests over a MessagePort to
 * the SourceWeft host, which adds the identity and version it rendered and
 * forwards them to the backend. Everything a page can name is therefore in this
 * file, and nothing here carries an owner, an artifact id or a role — those are
 * host-owned and derived from the session on the server.
 *
 * One storage model: a record is `(scope, collection, id) → JSON`. The
 * key/value SDK is shorthand over the reserved `kv` collection.
 */

export const ARTIFACT_RECORD_CAPABILITIES = [
  "storage",
  "storage.shared",
] as const;
export const artifactRecordCapabilitySchema = z.enum(
  ARTIFACT_RECORD_CAPABILITIES,
);
export type ArtifactRecordCapability = z.infer<
  typeof artifactRecordCapabilitySchema
>;

export const artifactRecordScopeSchema = z.enum(["user", "shared"]);
export type ArtifactRecordScope = z.infer<typeof artifactRecordScopeSchema>;

/** The collection the key/value shorthand reads and writes. */
export const ARTIFACT_RECORD_KV_COLLECTION = "kv";

export const ARTIFACT_RECORD_LIMITS = {
  /** UTF-8 bytes of one record's JSON text. */
  recordBytes: 256 * 1024,
  /** Nesting depth of one record's JSON value. */
  maxDepth: 64,
  recordsPerCollection: 10_000,
  collectionsPerArtifact: 50,
  /** Per viewer, per artifact. */
  userBytesPerArtifact: 5 * 1024 * 1024,
  sharedBytesPerArtifact: 20 * 1024 * 1024,
  queryDefaultLimit: 50,
  queryMaxLimit: 100,
  /** Stored bytes one query response may carry before it is cut short. */
  queryResponseBytes: 2 * 1024 * 1024,
  maxFilters: 8,
  maxOrderBy: 2,
  maxInValues: 20,
  queryTimeoutMs: 2_000,
  /** Fixed one-second windows, per viewer and artifact. */
  writesPerSecond: 10,
  readsPerSecond: 50,
  /** Collections an owner may expose read-only on a public share. */
  publicCollections: 20,
  /** Request body bytes accepted before parsing; a record plus envelope. */
  requestBytes: 300 * 1024,
} as const;

export const artifactRecordCollectionSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{1,64}$/u,
    "Collection names use 1-64 letters, digits, _ or -",
  );

export const artifactRecordIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9._:/-]{1,256}$/u,
    "Record ids use 1-256 letters, digits, or . _ : / -",
  );

/** A dotted field path into a record's JSON object. Never SQL, never jsonpath. */
export const artifactRecordPathSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,7}$/u,
    "Paths are up to 8 dot-separated field names",
  );

export const artifactRecordEtagSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/u, "Invalid etag");

export const artifactRecordCursorSchema = z.string().min(1).max(4096);

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const artifactRecordFilterSchema = z.discriminatedUnion("op", [
  z
    .object({
      path: artifactRecordPathSchema,
      op: z.enum(["eq", "ne", "contains"]),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      path: artifactRecordPathSchema,
      op: z.enum(["lt", "lte", "gt", "gte"]),
      value: z.union([z.string(), z.number()]),
    })
    .strict(),
  z
    .object({
      path: artifactRecordPathSchema,
      op: z.literal("in"),
      value: z
        .array(scalarSchema)
        .min(1)
        .max(ARTIFACT_RECORD_LIMITS.maxInValues),
    })
    .strict(),
  z
    .object({
      path: artifactRecordPathSchema,
      op: z.literal("exists"),
    })
    .strict(),
]);
export type ArtifactRecordFilter = z.infer<typeof artifactRecordFilterSchema>;

export const artifactRecordOrderSchema = z
  .object({
    path: artifactRecordPathSchema,
    dir: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export type ArtifactRecordOrder = z.infer<typeof artifactRecordOrderSchema>;

const target = {
  scope: artifactRecordScopeSchema.default("user"),
  collection: artifactRecordCollectionSchema,
};

/** What a page may ask for. The host adds nothing but the version it rendered. */
export const artifactRecordOperationSchema = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("get"), ...target, id: artifactRecordIdSchema })
    .strict(),
  z
    .object({
      op: z.literal("set"),
      ...target,
      id: artifactRecordIdSchema,
      data: z.unknown(),
      ifMatch: artifactRecordEtagSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      ...target,
      id: artifactRecordIdSchema,
      ifMatch: artifactRecordEtagSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("query"),
      ...target,
      where: z
        .array(artifactRecordFilterSchema)
        .max(ARTIFACT_RECORD_LIMITS.maxFilters)
        .default([]),
      orderBy: z
        .array(artifactRecordOrderSchema)
        .max(ARTIFACT_RECORD_LIMITS.maxOrderBy)
        .default([]),
      /** Record-id prefix; the key/value `list(prefix)` shorthand. */
      idPrefix: z
        .string()
        .regex(/^[A-Za-z0-9._:/-]{0,256}$/u)
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(ARTIFACT_RECORD_LIMITS.queryMaxLimit)
        .default(ARTIFACT_RECORD_LIMITS.queryDefaultLimit),
      cursor: artifactRecordCursorSchema.optional(),
    })
    .strict(),
]);
export type ArtifactRecordOperation = z.infer<
  typeof artifactRecordOperationSchema
>;
export type ArtifactRecordOperationInput = z.input<
  typeof artifactRecordOperationSchema
>;

/** Host → backend: the page's operation bound to the version that was rendered. */
export const artifactRecordRequestSchema = z
  .object({
    versionId: z.string().trim().min(1).max(200),
    operation: artifactRecordOperationSchema,
  })
  .strict();
export type ArtifactRecordRequest = z.infer<typeof artifactRecordRequestSchema>;

export type ArtifactRecord = {
  id: string;
  data: unknown;
  etag: string;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactRecordResult =
  | { op: "get"; record: ArtifactRecord | null }
  | { op: "set"; etag: string; updatedAt: string }
  | { op: "delete"; deleted: boolean }
  | { op: "query"; records: ArtifactRecord[]; cursor: string | null };

export const ARTIFACT_RECORD_ERROR_CODES = [
  "unavailable",
  "forbidden",
  "consent_required",
  "not_found",
  "conflict",
  "quota_exceeded",
  "rate_limited",
  "query_too_expensive",
  "invalid_request",
] as const;
export const artifactRecordErrorCodeSchema = z.enum(
  ARTIFACT_RECORD_ERROR_CODES,
);
export type ArtifactRecordErrorCode = z.infer<
  typeof artifactRecordErrorCodeSchema
>;

/** API error codes are namespaced; the page only ever sees the short code. */
export function artifactRecordApiErrorCode(code: ArtifactRecordErrorCode) {
  return `ARTIFACT_RECORD_${code.toUpperCase()}`;
}

export function artifactRecordErrorCodeFromApi(
  apiCode: unknown,
): ArtifactRecordErrorCode {
  if (typeof apiCode === "string" && apiCode.startsWith("ARTIFACT_RECORD_")) {
    const parsed = artifactRecordErrorCodeSchema.safeParse(
      apiCode.slice("ARTIFACT_RECORD_".length).toLowerCase(),
    );
    if (parsed.success) return parsed.data;
  }
  if (apiCode === "VALIDATION_ERROR" || apiCode === "INVALID_JSON")
    return "invalid_request";
  if (apiCode === "UNAUTHORIZED" || apiCode === "FORBIDDEN") return "forbidden";
  return "unavailable";
}

export type ArtifactRecordDataCheck =
  { ok: true; sizeBytes: number; text: string } | { ok: false; reason: string };

/**
 * Checks a parsed JSON value before it is stored as `jsonb`.
 *
 * `jsonb` rejects U+0000 and unpaired UTF-16 surrogates; rejecting them here
 * keeps the database error out of the page's view and keeps every stored value
 * castable. Depth is bounded before anything recurses further, so a hostile
 * value cannot drive the walk itself deep.
 */
export function checkArtifactRecordData(
  value: unknown,
): ArtifactRecordDataCheck {
  const problem = walk(value, 1);
  if (problem) return { ok: false, reason: problem };
  const text = JSON.stringify(value);
  const sizeBytes = new TextEncoder().encode(text).byteLength;
  if (sizeBytes > ARTIFACT_RECORD_LIMITS.recordBytes)
    return {
      ok: false,
      reason: `A record is limited to ${ARTIFACT_RECORD_LIMITS.recordBytes} bytes of JSON`,
    };
  return { ok: true, sizeBytes, text };
}

function checkString(value: string): string | null {
  if (value.includes("\u0000")) return "Strings cannot contain U+0000";
  if (!isWellFormedString(value))
    return "Strings cannot contain unpaired UTF-16 surrogates";
  return null;
}

function isWellFormedString(value: string) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function walk(value: unknown, depth: number): string | null {
  if (depth > ARTIFACT_RECORD_LIMITS.maxDepth)
    return `JSON nesting is limited to ${ARTIFACT_RECORD_LIMITS.maxDepth} levels`;
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? null : "Numbers must be finite";
  if (typeof value === "string") return checkString(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = walk(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return "Only plain JSON objects can be stored";
    for (const [key, item] of Object.entries(value)) {
      const problem = checkString(key) ?? walk(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  return "Only JSON values can be stored";
}

/* -------------------------------------------------------------------------- */
/* Page ↔ host bridge                                                          */
/* -------------------------------------------------------------------------- */

export const ARTIFACT_STORAGE_HELLO = "sourceweft.storage/hello";
export const ARTIFACT_STORAGE_WELCOME = "sourceweft.storage/welcome";
export const ARTIFACT_NAVIGATION_OPEN = "sourceweft.navigation/open";
export const ARTIFACT_BRIDGE_VERSION = 1;
/** Serialized size above which the host drops a bridge message unread. */
export const ARTIFACT_BRIDGE_MESSAGE_BYTES =
  ARTIFACT_RECORD_LIMITS.requestBytes;

export const artifactStorageHelloSchema = z
  .object({
    type: z.literal(ARTIFACT_STORAGE_HELLO),
    v: z.literal(ARTIFACT_BRIDGE_VERSION),
  })
  .strict();

export const artifactNavigationOpenSchema = z
  .object({
    type: z.literal(ARTIFACT_NAVIGATION_OPEN),
    v: z.literal(ARTIFACT_BRIDGE_VERSION),
    url: z.string().min(1).max(8192),
  })
  .strict();

/** One request on the port. `requestId` is the page's own correlation token. */
export const artifactBridgeRequestSchema = z
  .object({
    requestId: z.number().int().nonnegative(),
    operation: artifactRecordOperationSchema,
  })
  .strict();

export type ArtifactBridgeResponse =
  | { requestId: number; ok: true; result: ArtifactRecordResult }
  | {
      requestId: number;
      ok: false;
      error: { code: ArtifactRecordErrorCode; message: string };
    };

/**
 * Only plain web links leave the artifact, and only through the host's
 * confirmation. Everything else (javascript:, data:, blob:, file:, relative
 * paths into the artifact origin) is refused.
 */
export function parseArtifactExternalUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  return url;
}

/* -------------------------------------------------------------------------- */
/* Host transport                                                              */
/* -------------------------------------------------------------------------- */

export type ArtifactRecordPerson = { id: string; name: string | null };

/** What the host shows before a page may use shared records. */
export type ArtifactRecordsStatus = {
  storage: boolean;
  shared: boolean;
  author: ArtifactRecordPerson | null;
  approval: {
    approvedBy: ArtifactRecordPerson | null;
    approvedAt: string;
  } | null;
  consented: boolean;
  canApprove: boolean;
};

/** Failures a transport reports; `code` is what the page receives. */
export class ArtifactRecordTransportError extends Error {
  constructor(
    readonly code: ArtifactRecordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRecordTransportError";
  }
}

/**
 * How the host reaches the backend for one rendered version. The in-app host
 * binds workspace, artifact and version; the public share host binds only the
 * share token and offers no status or approval actions.
 */
export type ArtifactRecordsTransport = {
  execute(operation: ArtifactRecordOperation): Promise<ArtifactRecordResult>;
  status?: () => Promise<ArtifactRecordsStatus>;
  approveShared?: () => Promise<void>;
  revokeShared?: () => Promise<void>;
  grantSharedConsent?: () => Promise<void>;
};

/* -------------------------------------------------------------------------- */
/* Link confirmation                                                           */
/* -------------------------------------------------------------------------- */

const PUNYCODE = {
  base: 36,
  tMin: 1,
  tMax: 26,
  skew: 38,
  damp: 700,
  bias: 72,
  n: 128,
};

function adapt(delta: number, points: number, first: boolean) {
  let value = first ? Math.floor(delta / PUNYCODE.damp) : delta >> 1;
  value += Math.floor(value / points);
  let k = 0;
  while (value > ((PUNYCODE.base - PUNYCODE.tMin) * PUNYCODE.tMax) >> 1) {
    value = Math.floor(value / (PUNYCODE.base - PUNYCODE.tMin));
    k += PUNYCODE.base;
  }
  return (
    k +
    Math.floor(
      ((PUNYCODE.base - PUNYCODE.tMin + 1) * value) / (value + PUNYCODE.skew),
    )
  );
}

/** RFC 3492 decoding of one `xn--` label; null when it is not valid punycode. */
function decodePunycodeLabel(label: string): string | null {
  const input = label.slice(4);
  const output: number[] = [];
  const basicEnd = input.lastIndexOf("-");
  for (let index = 0; index < Math.max(basicEnd, 0); index++) {
    const code = input.charCodeAt(index);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = PUNYCODE.n;
  let bias = PUNYCODE.bias;
  let i = 0;
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length;) {
    const oldI = i;
    for (let w = 1, k = PUNYCODE.base; ; k += PUNYCODE.base) {
      if (index >= input.length) return null;
      const code = input.charCodeAt(index++);
      const digit =
        code - 48 < 10
          ? code - 22
          : code - 65 < 26
            ? code - 65
            : code - 97 < 26
              ? code - 97
              : PUNYCODE.base;
      if (digit >= PUNYCODE.base) return null;
      i += digit * w;
      const t =
        k <= bias
          ? PUNYCODE.tMin
          : k >= bias + PUNYCODE.tMax
            ? PUNYCODE.tMax
            : k - bias;
      if (digit < t) break;
      w *= PUNYCODE.base - t;
      if (w > 0x7fffffff) return null;
    }
    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/**
 * A URL's host as the browser will contact it (`ascii`, punycode) and as a
 * person reads it (`unicode`). Showing both exposes look-alike domains.
 */
export function describeArtifactLinkHost(hostname: string): {
  ascii: string;
  unicode: string;
  isInternationalized: boolean;
} {
  const ascii = hostname.toLowerCase();
  const labels = ascii
    .split(".")
    .map((label) =>
      label.startsWith("xn--") ? (decodePunycodeLabel(label) ?? label) : label,
    );
  const unicode = labels.join(".");
  return { ascii, unicode, isInternationalized: unicode !== ascii };
}

/**
 * The shared collections an artifact actually has, with their record counts.
 * Lets the owner pick what a public share exposes instead of typing names.
 */
export const artifactSharedCollectionSchema = z.object({
  collection: artifactRecordCollectionSchema,
  count: z.number().int().nonnegative(),
});
export const artifactSharedCollectionsResponseSchema = z.object({
  collections: z.array(artifactSharedCollectionSchema),
});
export type ArtifactSharedCollection = z.infer<
  typeof artifactSharedCollectionSchema
>;
export type ArtifactSharedCollectionsResponse = z.infer<
  typeof artifactSharedCollectionsResponseSchema
>;
