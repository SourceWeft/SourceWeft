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
    const pattern = new RegExp(input.schema.pattern);
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
