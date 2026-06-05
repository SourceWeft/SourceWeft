import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { parseOffice } from "officeparser";
import { test } from "vitest";
import { basicProductOverviewFixture } from "../__fixtures__";
import { PptxGenJsRendererAdapter } from "./pptxgenjs-renderer-adapter";

type ZipEntry = {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
  name: string;
};

test("PptxGenJsRendererAdapter renders a native editable PPTX buffer with metadata", async () => {
  const adapter = new PptxGenJsRendererAdapter();

  const result = await adapter.renderPresentation({
    source: basicProductOverviewFixture,
    options: { includeSpeakerNotes: true, sourceHash: "fixture-hash" },
  });

  assert.ok(Buffer.isBuffer(result.pptxBuffer));
  assert.ok(result.pptxBuffer.byteLength > 1000);
  assert.equal(result.metadata.engine, "pptxgenjs-native");
  assert.equal(result.metadata.slideCount, basicProductOverviewFixture.slides.length);
  assert.equal(result.metadata.sourceHash, "fixture-hash");
  assert.equal(result.metadata.editableCompatibility, "native-v1");
  const primitiveCounts = result.metadata.editablePrimitiveCountsBySlide ?? [];
  assert.equal(primitiveCounts.length, basicProductOverviewFixture.slides.length);
  assert.ok(primitiveCounts.every((slide) => slide.textBoxes > 0));
  assert.ok(primitiveCounts.every((slide) => slide.shapes >= slide.textBoxes));
  assert.match(result.metadata.generatedAtIso ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(result.metadata.warnings));
});

test("PptxGenJsRendererAdapter output exposes expected editable text", async () => {
  const adapter = new PptxGenJsRendererAdapter();
  const result = await adapter.renderPresentation({ source: basicProductOverviewFixture });

  const parsed = await parseOffice(result.pptxBuffer, {
    ignoreNotes: true,
    newlineDelimiter: "\n",
  });
  const text = parsed.toText();

  assert.match(text, /SourceWeft Product Overview/);
  assert.match(text, /Turn scattered knowledge into grounded team outputs/);
  assert.match(text, /Knowledge work is split across too many surfaces/);
  assert.match(text, /Connect sources/);
  assert.match(text, /Make grounded outputs the default team workflow/);
});

test("PptxGenJsRendererAdapter creates named editable content without flattened image-only slides", async () => {
  const adapter = new PptxGenJsRendererAdapter();
  const result = await adapter.renderPresentation({ source: basicProductOverviewFixture });
  const slideXml = extractPptxSlideXml(result.pptxBuffer);

  assert.equal(slideXml.length, basicProductOverviewFixture.slides.length);
  assert.ok(slideXml.every((entry) => /sw:content:/.test(entry.xml)));
  assert.ok(slideXml.some((entry) => /sw:chrome:/.test(entry.xml)));
  assert.ok(slideXml.every((entry) => extractPptxShapeText(entry.xml).trim().length > 0));
  assert.ok(slideXml.every((entry) => !/<p:pic\b/.test(entry.xml)));
  assert.ok(slideXml.every((entry) => /<p:sp\b/.test(entry.xml)));
});

test("PptxGenJsRendererAdapter does not emit empty visible shapes", async () => {
  const adapter = new PptxGenJsRendererAdapter();
  const result = await adapter.renderPresentation({ source: basicProductOverviewFixture });
  const warnings = inspectEmptyVisibleShapes(result.pptxBuffer);

  assert.deepEqual(warnings, []);
});

function readUInt16(buffer: Buffer, offset: number) {
  return offset >= 0 && offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0;
}

function readUInt32(buffer: Buffer, offset: number) {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

function extractZipEntries(buffer: Buffer) {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  const minEndOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minEndOffset; offset -= 1) {
    if (readUInt32(buffer, offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    return [];
  }

  const entryCount = readUInt16(buffer, endOffset + 10);
  const centralDirectoryOffset = readUInt32(buffer, endOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) {
      break;
    }
    const compressionMethod = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const fileNameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    entries.push({ compressionMethod, compressedSize, localHeaderOffset, name });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry) {
  const offset = entry.localHeaderOffset;
  if (readUInt32(buffer, offset) !== 0x04034b50) {
    return null;
  }
  const fileNameLength = readUInt16(buffer, offset + 26);
  const extraLength = readUInt16(buffer, offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressed);
  }
  return null;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractPptxSlideXml(buffer: Buffer) {
  return extractZipEntries(buffer)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((left, right) => extractSlideNumber(left.name) - extractSlideNumber(right.name))
    .map((entry) => ({
      path: entry.name,
      xml: readZipEntry(buffer, entry)?.toString("utf8") ?? "",
    }))
    .filter((entry) => entry.xml.length > 0);
}

function extractSlideNumber(path: string) {
  const match = path.match(/slide(\d+)\.xml$/);
  return match?.[1] ? Number(match[1]) : 0;
}

function extractPptxShapeFragments(slideXml: string) {
  const fragments: string[] = [];
  const pattern = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(slideXml))) {
    fragments.push(match[0]);
  }
  return fragments;
}

function extractPptxShapeText(fragment: string) {
  return Array.from(fragment.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g))
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .join("")
    .trim();
}

function extractPptxShapeName(fragment: string) {
  const match = fragment.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/);
  return match?.[1] ? decodeXmlEntities(match[1]) : "";
}

function inspectEmptyVisibleShapes(buffer: Buffer) {
  const warnings: string[] = [];
  for (const { path, xml } of extractPptxSlideXml(buffer)) {
    const slideNumber = extractSlideNumber(path);
    for (const fragment of extractPptxShapeFragments(xml)) {
      const name = extractPptxShapeName(fragment);
      const text = extractPptxShapeText(fragment);
      const hasFill = /<a:(?:solidFill|gradFill|pattFill)\b/.test(fragment);
      const line = fragment.match(/<a:ln\b[\s\S]*?<\/a:ln>/);
      const hasVisibleLine = Boolean(line && !/<a:noFill\b/.test(line[0]));
      if (!text && (hasFill || hasVisibleLine) && !/^sw:chrome:/i.test(name)) {
        warnings.push(`empty_visible_shape: slide_${slideNumber} ${name || "unnamed"}`);
      }
    }
  }
  return warnings;
}
