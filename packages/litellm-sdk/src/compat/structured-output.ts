import { LiteLLMError } from "../errors";
import type {
  LiteLLMResponseFormat,
  LiteLLMStructuredOutputConfig,
  StructuredOutputMethod,
} from "../types";
import { isRecord } from "../utils/object";

function enforceNoAdditionalProperties(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => enforceNoAdditionalProperties(item));
  }

  if (!isRecord(schema)) {
    return schema;
  }

  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isRecord(value)) {
      const nextProperties: Record<string, unknown> = {};
      for (const [propertyKey, propertySchema] of Object.entries(value)) {
        nextProperties[propertyKey] =
          enforceNoAdditionalProperties(propertySchema);
      }
      output.properties = nextProperties;
      continue;
    }

    if (
      key === "items" ||
      key === "anyOf" ||
      key === "oneOf" ||
      key === "allOf" ||
      key === "not"
    ) {
      output[key] = enforceNoAdditionalProperties(value);
      continue;
    }

    output[key] = value;
  }

  const hasObjectType =
    output.type === "object" ||
    (Array.isArray(output.type) && output.type.includes("object"));

  if (hasObjectType && output.additionalProperties === undefined) {
    output.additionalProperties = false;
  }

  return output;
}

function normalizeMethod(
  method: StructuredOutputMethod | undefined,
): StructuredOutputMethod {
  return method ?? "function_calling";
}

export function buildStructuredOutputRequest(
  config: LiteLLMStructuredOutputConfig | undefined,
): {
  responseFormat?: LiteLLMResponseFormat;
  extraBody?: Record<string, unknown>;
} {
  if (!config) {
    return {};
  }

  const method = normalizeMethod(config.method);

  if (method === "function_calling") {
    return {};
  }

  if (method === "json_mode") {
    return {
      responseFormat: {
        type: "json_object",
      },
    };
  }

  if (!config.schema) {
    throw new LiteLLMError({
      code: "BAD_REQUEST",
      message:
        "structuredOutput.schema is required when method is 'json_schema'",
      retryable: false,
    });
  }

  const strictSchema = config.strict
    ? (enforceNoAdditionalProperties(config.schema) as Record<string, unknown>)
    : config.schema;

  const name = config.name ?? "extract";

  return {
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name,
        description: config.description,
        schema: strictSchema,
        strict: config.strict,
      },
    },
  };
}

export function toStrictJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return enforceNoAdditionalProperties(schema) as Record<string, unknown>;
}
