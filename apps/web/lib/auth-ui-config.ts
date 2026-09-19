import { viewPaths, type AdditionalFields } from "@better-auth-ui/core";
import { emailOtpPlugin } from "@better-auth-ui/core/plugins/email-otp";
import { magicLinkPlugin } from "@better-auth-ui/core/plugins/magic-link";
import { organizationPlugin } from "@better-auth-ui/core/plugins/organization";
import { twoFactorPlugin } from "@better-auth-ui/core/plugins/two-factor";

// View paths are contributed by the core package plus whichever plugins are
// registered in `app/providers.tsx`. Keep this list in step with that array:
// a path missing here becomes a 404 because the routes set `dynamicParams`
// to false.
const authPlugins = [
  magicLinkPlugin,
  emailOtpPlugin,
  twoFactorPlugin,
  organizationPlugin,
];

function pluginViewPaths(scope: "auth" | "settings" | "organization") {
  return authPlugins.flatMap((plugin) => {
    const paths = plugin({}).viewPaths as
      | Partial<Record<typeof scope, Record<string, string>>>
      | undefined;
    return Object.values(paths?.[scope] ?? {});
  });
}

/**
 * Both of these have hand-written sibling routes that take precedence over
 * `[path]` anyway: `app/auth/accept-invitation/` also joins the invited user
 * to their workspace, and `app/auth/error/` renders our own error copy.
 * Generating them here as well would only add shadowed pages.
 */
const HAND_WRITTEN_AUTH_PATHS = new Set(["accept-invitation", "error"]);

export const authStaticPaths = Array.from(
  new Set([...Object.values(viewPaths.auth), ...pluginViewPaths("auth")]),
).filter((path) => !HAND_WRITTEN_AUTH_PATHS.has(path));

export const settingsStaticPaths = Array.from(
  new Set([
    ...Object.values(viewPaths.settings),
    ...pluginViewPaths("settings"),
  ]),
);

export const organizationStaticPaths = Array.from(
  new Set(pluginViewPaths("organization")),
);

/**
 * These render in the profile view only, never on sign-up, which is what the
 * old `account.fields` / `signUp.fields` pair expressed. The successor has no
 * per-field description, so those strings are gone.
 */
export const additionalFields: AdditionalFields = [
  {
    inputType: "textarea",
    label: "Bio",
    name: "bio",
    placeholder: "Tell people what you are building",
    profile: true,
    required: false,
    signUp: false,
    type: "string",
  },
  {
    label: "Company",
    name: "company",
    placeholder: "SourceWeft Inc.",
    profile: true,
    required: false,
    signUp: false,
    type: "string",
  },
  {
    label: "Role",
    name: "role",
    placeholder: "Founder / Engineer / PM",
    profile: true,
    required: false,
    signUp: false,
    type: "string",
  },
  {
    label: "Timezone",
    name: "timezone",
    placeholder: "Asia/Shanghai",
    profile: true,
    required: false,
    signUp: false,
    type: "string",
  },
];
