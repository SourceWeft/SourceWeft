import { ConnectorError } from "./errors";
import { isRecord } from "../../shared/records";

type JsonSchemaObject = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  enum?: unknown;
  anyOf?: unknown;
  maxItems?: unknown;
  uniqueItems?: unknown;
  pattern?: unknown;
  items?: unknown;
};

function validateValue(input: {
  schema: JsonSchemaObject;
  value: unknown;
  path: string;
}) {
  if (Array.isArray(input.schema.enum)) {
    if (!input.schema.enum.includes(input.value)) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SCHEMA_VALIDATION_FAILED",
        `${input.path} must be one of the allowed values`,
      );
    }
  }

  if (typeof input.schema.type !== "string") {
    return;
  }

  const type = input.schema.type;
  const valid =
    (type === "string" && typeof input.value === "string") ||
    (type === "number" && typeof input.value === "number") ||
    (type === "integer" &&
      typeof input.value === "number" &&
      Number.isInteger(input.value)) ||
    (type === "boolean" && typeof input.value === "boolean") ||
    (type === "array" && Array.isArray(input.value)) ||
    (type === "object" && isRecord(input.value)) ||
    (type === "null" && input.value === null);

  if (!valid) {
    throw new ConnectorError(
      400,
      "CONNECTOR_SCHEMA_VALIDATION_FAILED",
      `${input.path} must be ${type}`,
    );
  }

  if (type === "string" && typeof input.schema.pattern === "string") {
    let pattern: RegExp;
    try {
      pattern = new RegExp(input.schema.pattern);
    } catch {
      throw new ConnectorError(
        500,
        "CONNECTOR_SCHEMA_INVALID",
        `${input.path} declares an invalid pattern`,
      );
    }
    if (!pattern.test(input.value as string)) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SCHEMA_VALIDATION_FAILED",
        `${input.path} does not match the required pattern`,
      );
    }
  }

  if (type === "array") {
    const items = input.value as unknown[];

    if (
      typeof input.schema.maxItems === "number" &&
      items.length > input.schema.maxItems
    ) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SCHEMA_VALIDATION_FAILED",
        `${input.path} must have at most ${input.schema.maxItems} items`,
      );
    }

    if (input.schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of items) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          throw new ConnectorError(
            400,
            "CONNECTOR_SCHEMA_VALIDATION_FAILED",
            `${input.path} must not contain duplicate items`,
          );
        }
        seen.add(key);
      }
    }

    if (isRecord(input.schema.items)) {
      const itemSchema = input.schema.items as JsonSchemaObject;
      items.forEach((item, index) => {
        validateValue({
          schema: itemSchema,
          value: item,
          path: `${input.path}[${index}]`,
        });
      });
    }
  }

  // `type: "object"` is valid here for any nested occurrence (an array's
  // `items`, a property's own schema, …), not just the document root, so
  // `required`/`additionalProperties`/`properties` are enforced wherever an
  // object schema appears, with the same error codes as the top level.
  if (type === "object") {
    validateObjectConstraints({
      schema: input.schema,
      value: input.value as Record<string, unknown>,
      path: input.path,
    });
  }
}

function validateObjectConstraints(input: {
  schema: JsonSchemaObject;
  value: Record<string, unknown>;
  path: string;
}) {
  const { schema, value, path } = input;

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in value)) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SCHEMA_VALIDATION_FAILED",
        `${path}.${key} is required`,
      );
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.filter(isRecord);
    if (variants.length > 0) {
      const matched = variants.some((variant) => {
        try {
          const variantSchema = variant as JsonSchemaObject;
          // Re-run the variant's own type/enum check (a variant may narrow
          // to a non-object type, or to a different shape than its
          // siblings), then its object constraints, matching the root's
          // "no type still enforces object constraints" behavior below.
          validateValue({ schema: variantSchema, value, path });
          if (variantSchema.type !== "object") {
            validateObjectConstraints({ schema: variantSchema, value, path });
          }
          return true;
        } catch {
          return false;
        }
      });
      if (!matched) {
        throw new ConnectorError(
          400,
          "CONNECTOR_SCHEMA_VALIDATION_FAILED",
          `${path} must match at least one allowed shape`,
        );
      }
    }
  }

  if (!isRecord(schema.properties)) {
    return;
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new ConnectorError(
          400,
          "CONNECTOR_SCHEMA_VALIDATION_FAILED",
          `${path}.${key} is not allowed`,
        );
      }
    }
  }

  for (const [key, childSchema] of Object.entries(schema.properties)) {
    if (!(key in value) || !isRecord(childSchema)) {
      continue;
    }
    validateValue({
      schema: childSchema as JsonSchemaObject,
      value: value[key],
      path: `${path}.${key}`,
    });
  }
}

export function validateObjectWithJsonSchema(input: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  label: string;
}) {
  const schema = input.schema as JsonSchemaObject;
  validateValue({ schema, value: input.value, path: input.label });
  // The root schema is validated as an object even when it declares no
  // `type` (the pre-branch behavior): `validateValue` only reaches
  // `validateObjectConstraints` through the `type === "object"` branch, so
  // without an explicit type it would otherwise skip required/
  // additionalProperties/properties checks entirely.
  if (schema.type !== "object") {
    validateObjectConstraints({
      schema,
      value: input.value,
      path: input.label,
    });
  }
}
