import assert from "node:assert/strict";
import { test } from "vitest";
import { anydocFormatCatalog } from "@sourceweft/builtin-document-parsers/formats";
import {
  SOURCE_FILE_ACCEPT,
  getUploadFileLabel,
  isSupportedUploadFile,
} from "./upload";

test("upload picker accepts every AnyDoc extension from the shared browser-safe catalog", () => {
  const accepted = new Set(SOURCE_FILE_ACCEPT.split(","));
  for (const entry of anydocFormatCatalog) {
    for (const extension of entry.extensions) {
      const file = new File(["fixture"], `sample.${extension}`, {
        type: entry.mimeType,
      });
      assert.equal(accepted.has(`.${extension}`), true);
      assert.equal(isSupportedUploadFile(file), true);
      assert.equal(getUploadFileLabel(file), entry.format.toUpperCase());
    }
  }
  assert.equal(
    isSupportedUploadFile(
      new File(["fixture"], "archive.zip", { type: "application/zip" }),
    ),
    false,
  );
  assert.equal(
    isSupportedUploadFile(
      new File(["fixture"], "main.ts", { type: "application/typescript" }),
    ),
    true,
  );
});
