import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  connectorItemSkipReasons,
  isConnectorExtractedFile,
  isConnectorItemSkipError,
} from "../src/connectors";

const item = { externalId: "file:1", externalUri: null, title: "t", mimeType: null,
  sizeBytes: null, externalUpdatedAt: null, contentHash: null, metadata: {} };

test("text and file shapes are told apart", () => {
  assert.equal(isConnectorExtractedFile({ item, contentText: "x" }), false);
  assert.equal(
    isConnectorExtractedFile({ item, file: { fileName: "a.pdf", mimeType: "application/pdf",
      sizeBytes: 1, download: async () => Buffer.from("") } }),
    true,
  );
});

test("skip errors are recognised structurally", () => {
  assert.deepEqual([...connectorItemSkipReasons], [
    "unsupported_type", "too_large", "needs_ocr", "export_too_large", "empty_content"]);
  assert.equal(isConnectorItemSkipError(new ConnectorItemSkipError("too_large")), true);
  assert.equal(isConnectorItemSkipError({ code: "CONNECTOR_ITEM_SKIPPED", reason: "needs_ocr" }), true);
  assert.equal(isConnectorItemSkipError({ code: "CONNECTOR_ITEM_SKIPPED", reason: "nope" }), false);
  assert.equal(isConnectorItemSkipError(new Error("x")), false);
});
