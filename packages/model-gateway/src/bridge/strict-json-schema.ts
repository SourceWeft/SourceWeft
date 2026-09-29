import { normalizeGatewayError } from "../errors";
import { STRICT_JSON_SCHEMA_SUPPORT } from "../strict-json-schema-support";
import type {
  StrictJsonSchemaFallbackReason,
  StructuredOutputConfig,
} from "../types";
import { isRecord } from "../utils/object";

const JSON_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/**
 * Keywords that make a schema ineligible for automatic strict output. Strict
 * JSON-schema modes (OpenAI's Structured Outputs and the OpenRouter endpoints
 * that implement it) require a closed, fully required object model, and
 * commonly reject:
 *
 * - composition other than `anyOf`: `oneOf`, `allOf`, `not`;
 * - conditionals: `if` / `then` / `else`, `dependentRequired`,
 *   `dependentSchemas` and their draft-7 form `dependencies`;
 * - open or pattern-keyed objects: `patternProperties`, `propertyNames`,
 *   `unevaluatedProperties`, `minProperties`, `maxProperties`;
 * - tuple and containment arrays: `prefixItems`, `additionalItems`,
 *   `unevaluatedItems`, `contains`, `minContains`, `maxContains`;
 * - references: `$ref`, `$defs`, `definitions`, `$dynamicRef`,
 *   `$recursiveRef`. Some strict modes resolve references, but they are not
 *   resolved here, so a referenced sub-schema cannot be checked.
 *
 * Value constraints (`enum`, `const`, `minLength`, `maxLength`, `minItems`,
 * `maxItems`, `pattern`, `format`, numeric bounds) are allowed: OpenRouter's
 * strict endpoints accept the length and item bounds (verified live). A
 * Provider that still rejects a schema answers "Invalid schema for
 * response_format", which falls back to the non-strict path automatically.
 */
const REJECTED_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "minProperties",
  "maxProperties",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "$ref",
  "$defs",
  "definitions",
  "$dynamicRef",
  "$recursiveRef",
] as const;

/** The node's declared types; null when `type` is present but malformed. */
function declaredTypes(
  node: Record<string, unknown>,
): string[] | undefined | null {
  if (node.type === undefined) return undefined;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (
    types.length === 0 ||
    !types.every((type) => typeof type === "string" && JSON_TYPES.has(type))
  ) {
    return null;
  }
  return types as string[];
}

function isClosedObject(
  node: Record<string, unknown>,
  ancestors: Set<unknown>,
): boolean {
  if (node.additionalProperties !== false) return false;
  if (!isRecord(node.properties)) return false;
  const keys = Object.keys(node.properties);
  if (!Array.isArray(node.required)) return false;
  const required = node.required;
  if (!required.every((name) => typeof name === "string")) return false;
  const requiredNames = new Set(required as string[]);
  if (requiredNames.size !== required.length) return false;
  if (requiredNames.size !== keys.length) return false;
  if (!keys.every((key) => requiredNames.has(key))) return false;
  return keys.every((key) =>
    isCompatibleNode(
      (node.properties as Record<string, unknown>)[key],
      ancestors,
    ),
  );
}

function isCompatibleNode(node: unknown, ancestors: Set<unknown>): boolean {
  if (!isRecord(node) || ancestors.has(node)) return false;
  if (REJECTED_KEYWORDS.some((keyword) => keyword in node)) return false;
  const types = declaredTypes(node);
  if (types === null) return false;

  ancestors.add(node);
  try {
    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) return false;
      if (!node.anyOf.every((branch) => isCompatibleNode(branch, ancestors))) {
        return false;
      }
    }
    if (types === undefined) {
      // An untyped node is only a union (`anyOf`) or a literal set.
      if (
        node.anyOf === undefined &&
        !Array.isArray(node.enum) &&
        !("const" in node)
      ) {
        return false;
      }
      if ("properties" in node || "items" in node) return false;
      return true;
    }
    if (types.includes("object") || "properties" in node) {
      if (!types.includes("object")) return false;
      if (!isClosedObject(node, ancestors)) return false;
    }
    if (types.includes("array") || "items" in node) {
      if (!types.includes("array")) return false;
      if (!isCompatibleNode(node.items, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(node);
  }
}

/**
 * Whether a JSON schema can be sent as a strict `json_schema` response format
 * as-is: an object root; every object node closed (`additionalProperties:
 * false`) with a `required` array naming exactly its `properties`; recursion
 * through `properties`, `items`, `anyOf` and type arrays (`["string",
 * "null"]`); and none of the keywords strict modes commonly reject (see
 * {@link REJECTED_KEYWORDS}). Pure; the schema is never modified — a schema
 * that is not compatible simply keeps the non-strict path.
 */
export function isStrictJsonSchemaCompatible(schema: unknown): boolean {
  if (!isRecord(schema) || schema.type !== "object") return false;
  return isCompatibleNode(schema, new Set());
}

export type StrictJsonSchemaIneligibleReason =
  /** The caller pinned a method, which is authoritative. */
  | "method_pinned"
  /** The caller passed `strict: false`. */
  | "strict_disabled"
  /** The target's Provider does not declare `json_schema_strict`. */
  | "provider_undeclared"
  | "schema_incompatible"
  /** The (Provider, model) rejected strict output recently. */
  | "known_unsupported";

export type StrictJsonSchemaEligibility =
  | { eligible: true }
  | { eligible: false; reason: StrictJsonSchemaIneligibleReason };

/** Whether this request should use strict JSON-schema output, and why not. */
export function strictJsonSchemaEligibility(input: {
  method?: StructuredOutputConfig["method"];
  strict?: boolean;
  supports: readonly string[];
  schema: unknown;
  knownUnsupported: boolean;
}): StrictJsonSchemaEligibility {
  if (input.method !== undefined) {
    return { eligible: false, reason: "method_pinned" };
  }
  if (input.strict === false) {
    return { eligible: false, reason: "strict_disabled" };
  }
  if (!input.supports.includes(STRICT_JSON_SCHEMA_SUPPORT)) {
    return { eligible: false, reason: "provider_undeclared" };
  }
  if (!isStrictJsonSchemaCompatible(input.schema)) {
    return { eligible: false, reason: "schema_incompatible" };
  }
  if (input.knownUnsupported) {
    return { eligible: false, reason: "known_unsupported" };
  }
  return { eligible: true };
}

const NO_ENDPOINTS_FOR_PARAMETERS =
  /no endpoints found that can handle the requested parameters/iu;
const INVALID_RESPONSE_FORMAT_SCHEMA = /invalid schema for response_format/iu;
const MENTIONS_RESPONSE_FORMAT = /response_format|json_schema/iu;
const NOT_SUPPORTED =
  /unavailable|unsupported|not supported|does not support|doesn't support/iu;

/**
 * The provider error objects (`{ message, code, metadata }`) an error carries:
 * the OpenAI SDK keeps the body's `error` on `.error`, a gateway HTTP error
 * keeps the whole body on `.metadata`, and a normalized error keeps the SDK
 * error as its `cause`.
 */
function providerErrorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (isRecord(current.error)) records.push(current.error);
    if (isRecord(current.metadata) && isRecord(current.metadata.error)) {
      records.push(current.metadata.error);
    }
    current = current.cause;
  }
  return records;
}

/**
 * Recognizes a Provider's refusal of a strict `json_schema` response format —
 * the only errors that fall back to the non-strict path:
 *
 * - `no_endpoint_for_parameters`: OpenRouter's 404 "No endpoints found that
 *   can handle the requested parameters" (`metadata.failed_routing_step`
 *   "Filter by Parameters"), raised under `provider.require_parameters` when
 *   no endpoint of the model supports the response format;
 * - `response_format_unsupported`: a 400 saying a `response_format` /
 *   `json_schema` is unavailable or not supported (DeepSeek: "This
 *   response_format type is unavailable now");
 * - `invalid_schema`: a 400 "Invalid schema for response_format", a strict
 *   mode refusing a keyword the local compatibility check allows.
 *
 * The 400 texts are matched in the message and in OpenRouter's relayed
 * upstream body (`metadata.raw`). Everything else — other 4xx/5xx, timeouts,
 * aborts, parse failures — returns undefined and propagates unchanged.
 */
export function classifyStrictJsonSchemaRejection(
  error: unknown,
): StrictJsonSchemaFallbackReason | undefined {
  if (!isRecord(error)) return undefined;
  const normalized = normalizeGatewayError(error);
  const status = normalized.statusCode;
  if (status !== 400 && status !== 404) return undefined;
  const records = providerErrorRecords(error);
  const texts = [normalized.message];
  for (const record of records) {
    if (typeof record.message === "string") texts.push(record.message);
    if (isRecord(record.metadata) && typeof record.metadata.raw === "string") {
      texts.push(record.metadata.raw);
    }
  }

  if (status === 404) {
    const filteredByParameters = records.some(
      (record) =>
        isRecord(record.metadata) &&
        record.metadata.failed_routing_step === "Filter by Parameters",
    );
    return filteredByParameters ||
      texts.some((text) => NO_ENDPOINTS_FOR_PARAMETERS.test(text))
      ? "no_endpoint_for_parameters"
      : undefined;
  }
  if (texts.some((text) => INVALID_RESPONSE_FORMAT_SCHEMA.test(text))) {
    return "invalid_schema";
  }
  if (
    texts.some(
      (text) => MENTIONS_RESPONSE_FORMAT.test(text) && NOT_SUPPORTED.test(text),
    )
  ) {
    return "response_format_unsupported";
  }
  return undefined;
}
