import type { z } from "zod";
import { PresentationSourceV1Schema } from "./schemas";
import type { PresentationSourceV1 } from "./schemas";

export { PresentationSourceV1Schema };

export const presentationSourceValidationIssueCodes = [
  "SCHEMA_INVALID",
  "LAYOUT_SPEC_INVALID",
] as const;

export type PresentationSourceValidationIssueCode =
  (typeof presentationSourceValidationIssueCodes)[number];

export type PresentationSourceValidationIssue = {
  code: PresentationSourceValidationIssueCode;
  path: Array<string | number>;
  message: string;
};

export type PresentationSourceValidationResult =
  | { success: true; data: PresentationSourceV1; issues: [] }
  | { success: false; issues: PresentationSourceValidationIssue[] };

export function validatePresentationSourceV1(
  input: unknown,
): PresentationSourceValidationResult {
  const parsed = PresentationSourceV1Schema.safeParse(input);

  if (parsed.success) {
    return { success: true, data: parsed.data, issues: [] };
  }

  return {
    success: false,
    issues: parsed.error.issues.map(toPresentationSourceValidationIssue),
  };
}

function toPresentationSourceValidationIssue(
  issue: z.core.$ZodIssue,
): PresentationSourceValidationIssue {
  return {
    code: issue.path.includes("layoutSpec")
      ? "LAYOUT_SPEC_INVALID"
      : "SCHEMA_INVALID",
    path: issue.path.filter((part) => typeof part === "string" || typeof part === "number"),
    message: issue.message,
  };
}
