import type { ReactNode } from "react";

export type FieldType = "string" | "number" | "boolean" | "select";

export type AdditionalField = {
  description?: ReactNode;
  instructions?: ReactNode;
  label: ReactNode;
  placeholder?: string;
  required?: boolean;
  type: FieldType;
  multiline?: boolean;
  validate?: (value: string) => Promise<boolean>;
  errorMessage?: {
    required?: string;
    invalid?: string;
    validate?: string;
  };
};

export type AdditionalFields = Record<string, AdditionalField>;
