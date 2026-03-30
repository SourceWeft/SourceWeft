import {
  accountViewPaths,
  authViewPaths,
  organizationViewPaths,
  type AccountViewPaths,
  type AuthViewPaths,
  type OrganizationViewPaths,
} from "@daveyplate/better-auth-ui";
import type { AdditionalFields } from "./auth-ui-types";

export const customAuthViewPaths: AuthViewPaths = {
  ...authViewPaths,
  ACCEPT_INVITATION: "accept-invitation",
  CALLBACK: "callback",
  EMAIL_OTP: "email-otp",
  EMAIL_VERIFICATION: "verify-email",
  FORGOT_PASSWORD: "forgot-password",
  MAGIC_LINK: "magic-link",
  RECOVER_ACCOUNT: "recover-account",
  RESET_PASSWORD: "reset-password",
  SIGN_IN: "sign-in",
  SIGN_OUT: "sign-out",
  SIGN_UP: "sign-up",
  TWO_FACTOR: "two-factor",
};

export const customAccountViewPaths: AccountViewPaths = {
  ...accountViewPaths,
  API_KEYS: "keys",
  ORGANIZATIONS: "organizations",
  SECURITY: "security",
  SETTINGS: "profile",
  TEAMS: "teams",
};

export const customOrganizationViewPaths: OrganizationViewPaths = {
  ...organizationViewPaths,
  API_KEYS: "keys",
  MEMBERS: "members",
  SETTINGS: "settings",
  TEAMS: "teams",
};

export const authStaticPaths = Array.from(
  new Set(
    Object.values(customAuthViewPaths).filter(
      (path) => path !== customAuthViewPaths.ACCEPT_INVITATION,
    ),
  ),
);
export const accountStaticPaths = Object.values(customAccountViewPaths);
export const organizationStaticPaths = Object.values(
  customOrganizationViewPaths,
);

export const additionalFields: AdditionalFields = {
  bio: {
    description: "Displayed in your profile",
    label: "Bio",
    multiline: true,
    placeholder: "Tell people what you are building",
    required: false,
    type: "string",
  },
  company: {
    description: "Used for organization and billing context",
    label: "Company",
    placeholder: "VelaMind Inc.",
    required: false,
    type: "string",
  },
  role: {
    description: "Your role in the team",
    label: "Role",
    placeholder: "Founder / Engineer / PM",
    required: false,
    type: "string",
  },
  timezone: {
    description: "Used for notifications and scheduling",
    label: "Timezone",
    placeholder: "Asia/Shanghai",
    required: false,
    type: "string",
  },
};
