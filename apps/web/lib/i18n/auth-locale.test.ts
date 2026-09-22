import { describe, expect, it } from "vitest";
import { defaultAuthLocale, resolveAuthConfig } from "@better-auth-ui/core";
import { magicLinkPlugin } from "@better-auth-ui/core/plugins/magic-link";
import { emailOtpPlugin } from "@better-auth-ui/core/plugins/email-otp";
import { passkeyPlugin } from "@better-auth-ui/core/plugins/passkey";
import { twoFactorPlugin } from "@better-auth-ui/core/plugins/two-factor";
import { multiSessionPlugin } from "@better-auth-ui/core/plugins/multi-session";
import { apiKeyPlugin } from "@better-auth-ui/core/plugins/api-key";
import { organizationPlugin } from "@better-auth-ui/core/plugins/organization";
import { buildAuthLocale } from "./auth-locale";
import en from "../../messages/en.json";
import cn from "../../messages/zh-CN.json";
import tw from "../../messages/zh-TW.json";

function leaves(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  return Object.assign(
    {},
    ...Object.entries(value as object).map(([key, child]) =>
      leaves(child, `${prefix}.${key}`),
    ),
  );
}
const plugins = [
  magicLinkPlugin(),
  emailOtpPlugin({ signIn: true }),
  passkeyPlugin(),
  twoFactorPlugin({ enrollmentMethods: ["otp", "totp"] }),
  multiSessionPlugin(),
  apiKeyPlugin({ organization: true }),
  organizationPlugin({}),
];
const expected = leaves({
  core: defaultAuthLocale.localization,
  plugins: Object.fromEntries(plugins.map((p) => [p.id, p.localization])),
});
for (const [id, catalog] of [
  ["en", en],
  ["zh-CN", cn],
  ["zh-TW", tw],
] as const) {
  describe(id, () => {
    it("covers the installed auth core and every registered plugin, preserving raw interpolation", () => {
      const actual = leaves(catalog.authLocale);
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const [key, value] of Object.entries(actual)) {
        expect(value.trim(), key).not.toBe("");
        expect(
          [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort(),
          key,
        ).toEqual(
          [...expected[key]!.matchAll(/\{\{(\w+)\}\}/g)]
            .map((m) => m[1])
            .sort(),
        );
      }
    });
    it("uses translated core and plugin messages without changing the registered plugins", () => {
      const locale = buildAuthLocale(id, catalog.authLocale);
      expect(locale.localization.auth.signIn).toBe(
        catalog.authLocale.core.auth.signIn,
      );
      const config = resolveAuthConfig({
        authClient: {} as Parameters<typeof resolveAuthConfig>[0]["authClient"],
        plugins,
        locale,
      });
      expect(config.localization).toEqual(catalog.authLocale.core);
      const localized = config.plugins;
      expect(localized.map((p) => p.id)).toEqual(plugins.map((p) => p.id));
      expect(
        localized.find((p) => p.id === "organization")?.localization,
      ).toEqual(catalog.authLocale.plugins.organization);
      expect(
        plugins.find((p) => p.id === "organization")?.localization,
      ).toEqual(en.authLocale.plugins.organization);
    });
  });
}
