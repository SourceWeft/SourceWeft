import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySourceFile,
  CONNECTOR_FILE_KINDS,
  isConnectorIndexableFile,
} from "../src/source-file-types";

// Representative cases for the classifier moved here from the backend
// (apps/backend/src/modules/sources/source-file-classifier.ts), unchanged in
// behavior: the backend's own tests are the guard for that, this just covers
// the shared module directly so it is also exercised browser-side.
const classificationCases: {
  name: string;
  fileName: string;
  kind: string;
}[] = [
  { name: "json file", fileName: "data.json", kind: "json" },
  { name: "yaml file", fileName: "config.yaml", kind: "text" },
  { name: "xml file", fileName: "feed.xml", kind: "text" },
  { name: "html file", fileName: "index.html", kind: "text" },
  { name: "log file", fileName: "server.log", kind: "text" },
  { name: "python file", fileName: "script.py", kind: "text" },
  { name: "docx file", fileName: "report.docx", kind: "document" },
  { name: "pdf file", fileName: "report.pdf", kind: "document" },
  { name: "epub file", fileName: "book.epub", kind: "document" },
  { name: "csv file", fileName: "data.csv", kind: "table" },
  { name: "png file", fileName: "photo.png", kind: "image" },
  { name: "srt file", fileName: "captions.srt", kind: "transcript" },
  { name: "Dockerfile (no extension)", fileName: "Dockerfile", kind: "text" },
  { name: ".env (special name)", fileName: ".env", kind: "text" },
];

for (const fixture of classificationCases) {
  test(`classifySourceFile: ${fixture.name} classifies as ${fixture.kind}`, () => {
    const result = classifySourceFile({ fileName: fixture.fileName });
    assert.equal(result.supported, true);
    assert.equal(result.supported && result.kind, fixture.kind);
  });
}

test("classifySourceFile: unknown extension is unsupported", () => {
  const result = classifySourceFile({ fileName: "archive.rar" });
  assert.equal(result.supported, false);
});

const indexableCases: { fileName: string; expected: boolean }[] = [
  { fileName: "data.json", expected: true },
  { fileName: "config.yaml", expected: true },
  { fileName: "report.pdf", expected: true },
  { fileName: "photo.png", expected: false },
  { fileName: "talk.mp3", expected: false },
  { fileName: "captions.srt", expected: false },
];

for (const fixture of indexableCases) {
  test(`isConnectorIndexableFile: ${fixture.fileName} -> ${fixture.expected}`, () => {
    assert.equal(isConnectorIndexableFile(fixture.fileName), fixture.expected);
  });
}

test("CONNECTOR_FILE_KINDS contains exactly the connector-resolvable kinds", () => {
  assert.deepEqual(
    [...CONNECTOR_FILE_KINDS].sort(),
    ["document", "json", "table", "text"].sort(),
  );
});
