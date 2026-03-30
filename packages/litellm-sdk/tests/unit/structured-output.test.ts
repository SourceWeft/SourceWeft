import { describe, expect, it } from "vitest";
import {
  buildStructuredOutputRequest,
  toStrictJsonSchema,
} from "../../src/compat/structured-output";

describe("structured output compatibility", () => {
  it("creates json mode response format", () => {
    const output = buildStructuredOutputRequest({
      method: "json_mode",
    });

    expect(output.responseFormat).toEqual({
      type: "json_object",
    });
  });

  it("enforces additionalProperties=false recursively for strict schemas", () => {
    const schema = {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: {
            name: {
              type: "string",
            },
          },
          required: ["name"],
        },
      },
      required: ["profile"],
    };

    const strict = toStrictJsonSchema(schema);

    expect(strict).toMatchObject({
      additionalProperties: false,
      properties: {
        profile: {
          additionalProperties: false,
        },
      },
    });
  });
});
