import { ConnectorError } from "./errors";

type JsonSchemaObject = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  enum?: unknown;
  anyOf?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
}

export function validateObjectWithJsonSchema(input: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  label: string;
}) {
  const schema = input.schema as JsonSchemaObject;
  validateValue({ schema, value: input.value, path: input.label });

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in input.value)) {
      throw new ConnectorError(
        400,
        "CONNECTOR_SCHEMA_VALIDATION_FAILED",
        `${input.label}.${key} is required`,
      );
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.filter(isRecord);
    if (variants.length > 0) {
      const matched = variants.some((variant) => {
        try {
          validateObjectWithJsonSchema({
            schema: variant,
            value: input.value,
            label: input.label,
          });
          return true;
        } catch {
          return false;
        }
      });
      if (!matched) {
        throw new ConnectorError(
          400,
          "CONNECTOR_SCHEMA_VALIDATION_FAILED",
          `${input.label} must match at least one allowed shape`,
        );
      }
    }
  }

  if (!isRecord(schema.properties)) {
    return;
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(input.value)) {
      if (!allowed.has(key)) {
        throw new ConnectorError(
          400,
          "CONNECTOR_SCHEMA_VALIDATION_FAILED",
          `${input.label}.${key} is not allowed`,
        );
      }
    }
  }

  for (const [key, childSchema] of Object.entries(schema.properties)) {
    if (!(key in input.value) || !isRecord(childSchema)) {
      continue;
    }
    validateValue({
      schema: childSchema as JsonSchemaObject,
      value: input.value[key],
      path: `${input.label}.${key}`,
    });
  }
}
