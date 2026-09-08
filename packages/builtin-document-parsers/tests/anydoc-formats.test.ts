import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  anydocFormatCatalog,
  anydocExtensions,
  anydocMimeTypes,
  getAnydocFormatByExtension,
  getAnydocFormatByMimeType,
} from "../src/anydoc-formats";
import { getPureSourceParser } from "../src/registry";
import { parseWithAnydoc } from "../src/anydoc";

const nativeCases: Readonly<Record<string, readonly [string, string]>> = {
  doc: ["upstream-v0.2.4/text.doc", "Fixture Document"],
  docx: ["sample.docx", "1234.56"],
  docm: ["sample.docm", "1234.56"],
  ppt: ["upstream-v0.2.4/pres.ppt", "Deck Title Slide"],
  pps: ["upstream-v0.2.4/pres.ppt", "Deck Title Slide"],
  pot: ["upstream-v0.2.4/pres.ppt", "Deck Title Slide"],
  pptx: ["sample.pptx", "SourceWeft slide 42"],
  pptm: ["sample.pptm", "SourceWeft slide 42"],
  ppsx: ["sample.ppsx", "SourceWeft slide 42"],
  ppsm: ["sample.ppsm", "SourceWeft slide 42"],
  xls: ["upstream-v0.2.4/sheet.xls", "$1,234.50"],
  xlsx: ["upstream-v0.2.4/sheet.xlsx", "$1,234.50"],
  xlsm: ["sample.xlsm", "$1,234.50"],
  xlsb: ["upstream-v0.2.4/handmade-sheet.xlsb", "$1,234.50"],
  odt: ["upstream-v0.2.4/text.odt", "Fixture Document"],
  ods: ["upstream-v0.2.4/sheet.ods", "15.5%"],
  odp: ["upstream-v0.2.4/pres.odp", "Numbers Slide"],
  rtf: ["upstream-v0.2.4/text.rtf", "Fixture Document"],
  epub: ["sample.epub", "9876"],
  csv: ["sample.csv", "1234.56"],
  pdf: ["text.pdf", "5678"],
};

test("shared capability catalog matches every official native extension", async () => {
  const { formatFromExtension } = await import("@firecrawl/anydoc");
  assert.equal(anydocExtensions.length, 21);
  assert.equal(new Set(anydocExtensions).size, anydocExtensions.length);
  assert.equal(new Set(anydocMimeTypes).size, anydocMimeTypes.length);
  assert.deepEqual(
    [...anydocExtensions].sort(),
    Object.keys(nativeCases).sort(),
  );
  for (const entry of anydocFormatCatalog) {
    for (const extension of entry.extensions) {
      assert.equal(formatFromExtension(extension), entry.format);
      assert.equal(
        getAnydocFormatByExtension(`.${extension.toUpperCase()}`),
        entry,
      );
    }
    for (const mime of [entry.mimeType, ...entry.mimeAliases]) {
      assert.equal(getAnydocFormatByMimeType(mime.toUpperCase()), entry);
      assert.equal(getPureSourceParser(mime)?.id, "anydoc");
    }
  }
  assert.equal(getAnydocFormatByExtension("html"), undefined);
  assert.equal(getAnydocFormatByMimeType("image/png"), undefined);
});

for (const [extension, [path, expected]] of Object.entries(nativeCases)) {
  test(`native AnyDoc fully parses .${extension} through its sole registered engine`, async () => {
    const entry = getAnydocFormatByExtension(extension)!;
    const bytes = await readFile(
      new URL(`./fixtures/anydoc/${path}`, import.meta.url),
    );
    const parsed = await parseWithAnydoc({
      fileName: `fixture.${extension}`,
      mimeType: entry.mimeType,
      fileSize: bytes.length,
      content: bytes,
      config: { chunkSize: 512, parserVersion: "anydoc-all-formats" },
    });
    assert.ok(parsed.content.includes(expected), parsed.content);
    assert.equal(parsed.metadata.detectedFormat, entry.format);
    assert.equal(parsed.metadata.documentParseBackend, "anydoc");
    assert.ok(parsed.chunks.length > 0);
    assert.deepEqual(parsed.pages, []);
    assert.equal(parsed.metadata.billingPageCount, undefined);
  });
}
