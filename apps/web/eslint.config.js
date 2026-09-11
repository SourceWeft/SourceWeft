import { globalIgnores } from "eslint/config";
import { nextJsConfig } from "@sourceweft/eslint-config/next-js";

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  // Vendor assets copied by @sourceweft/preview, not application source.
  globalIgnores(["public/file-viewer/vendor/**"]),
];
