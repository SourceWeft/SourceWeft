import type {
  AuthFormClassNames,
  AuthHooks,
  AuthLocalization,
  AuthMutators,
  AuthViewClassNames,
  AuthViewPaths,
  SettingsCardClassNames,
  UserAvatarClassNames,
  UserButtonClassNames,
} from "@daveyplate/better-auth-ui";
import type { EmailTemplateClassNames } from "@daveyplate/better-auth-ui/server";
import type { ReactNode } from "react";

export type {
  AuthFormClassNames,
  AuthHooks,
  AuthLocalization,
  AuthMutators,
  AuthViewClassNames,
  AuthViewPaths,
  EmailTemplateClassNames,
  SettingsCardClassNames,
  UserAvatarClassNames,
  UserButtonClassNames,
};

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

export type ModelNames = {
  user: string;
  session: string;
  account: string;
  passkey: string;
};

export type Profile = {
  id?: string | number;
  email?: string | null;
  name?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  image?: string | null;
  emailVerified?: boolean | null;
};

export type FetchError = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
};
