import { globalIgnores } from "eslint/config";
import { nextJsConfig } from "@sourceweft/eslint-config/next-js";

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/_components/brand-icons.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@daveyplate/better-auth-ui",
              importNames: ["AppleIcon", "GoogleIcon", "GitHubIcon"],
              message:
                "Import brand icons through app/_components/brand-icons so all pages share one entry point.",
            },
            {
              name: "lucide-react",
              importNames: ["Apple", "AppleIcon", "Github", "GithubIcon"],
              message:
                "Use app/_components/brand-icons for brand artwork shared with web sign-in.",
            },
          ],
        },
      ],
    },
  },
  // Vendor assets copied by @sourceweft/preview, not application source.
  globalIgnores(["public/file-viewer/vendor/**"]),
];
