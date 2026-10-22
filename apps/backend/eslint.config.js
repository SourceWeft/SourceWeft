import { config as baseConfig } from "@sourceweft/eslint-config/base";
import globals from "globals";

/**
 * Backend ESLint configuration.
 *
 * The notable rule here is the model-gateway import zone: billing is enforced
 * structurally, so nothing outside `src/shared/model-gateway/**` may reach for
 * the gateway package directly. See also the architecture guards in
 * `src/shared/model-gateway/architecture.test.ts`.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  ...baseConfig,
  {
    ignores: ["dist/**", "node_modules/**", "drizzle/**"],
  },
  {
    // Plain Node scripts (storage init, asset copy) run outside TypeScript.
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      // This rule guards env vars inlined into cached build outputs. The
      // backend reads its environment at runtime (tsup leaves process.env
      // untouched) and loads .env itself, so turbo's hash is unaffected.
      "turbo/no-undeclared-env-vars": "off",
      // A leading underscore marks a deliberately unused binding: interface
      // parameters, and properties omitted via `const { x: _x, ...rest }`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@sourceweft/model-gateway",
              // Types carry no runtime access, so they can never bypass billing.
              allowTypeImports: true,
              message:
                "Do not import @sourceweft/model-gateway directly. Model calls must declare a billing intent: use withBilledModelGateway / openBilledModelGateway from src/shared/model-gateway/index.ts. Type-only imports (`import type`) are allowed. Only src/shared/model-gateway/** may talk to the gateway package.",
            },
          ],
        },
      ],
    },
  },
  {
    // The gateway boundary itself is the one place allowed to wrap the package.
    files: ["src/shared/model-gateway/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
];
