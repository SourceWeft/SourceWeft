import { inflateRawSync } from "node:zlib";

export type OoxmlZipEntry = {
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
  readonly name: string;
  readonly uncompressedSize: number;
};

export type OoxmlSlideShape = {
  readonly fragment: string;
  readonly name: string;
  readonly text: string;
  readonly x?: number;
  readonly y?: number;
  readonly cx?: number;
  readonly cy?: number;
  readonly prst: string;
  readonly hasVisibleEmptyShapeStyling: boolean;
};

export type OoxmlEditablePrimitiveCounts = {
  readonly textBoxes: number;
  readonly shapes: number;
  readonly images: number;
  readonly tables: number;
  readonly charts: number;
};

export type OoxmlSlideImage = {
  readonly fragment: string;
  readonly name: string;
  readonly x?: number;
  readonly y?: number;
  readonly cx?: number;
  readonly cy?: number;
  readonly relationshipId?: string;
};

export type OoxmlSlideInspection = {
  readonly path: string;
  readonly slideNumber: number;
  readonly xml: string;
  readonly text: string;
  readonly shapes: OoxmlSlideShape[];
  readonly images: OoxmlSlideImage[];
  readonly editablePrimitiveCounts: OoxmlEditablePrimitiveCounts;
  readonly hasImageOnlyTextFlatteningRisk: boolean;
  readonly imageRelationshipTargets: string[];
};

export type OoxmlPptxInspection = {
  readonly ok: boolean;
  readonly errors: string[];
  readonly entries: OoxmlZipEntry[];
  readonly entryNames: Set<string>;
  readonly slides: OoxmlSlideInspection[];
};

export function inspectOoxmlPptx(buffer: Buffer): OoxmlPptxInspection {
  const errors: string[] = [];
  const entries = extractZipEntries(buffer, errors);
  const entryNames = new Set(entries.map((entry) => entry.name));
  const slides: OoxmlSlideInspection[] = [];

  if (entries.length === 0) {
    return { ok: false, errors, entries, entryNames, slides };
  }

  for (const entry of entries.filter((item) => /^ppt\/slides\/slide\d+\.xml$/.test(item.name)).sort((left, right) => extractSlideNumber(left.name) - extractSlideNumber(right.name))) {
    const xml = readZipEntry(buffer, entry, errors)?.toString("utf8") ?? "";
    if (!xml) {
      errors.push(`Unable to read slide XML ${entry.name}.`);
      continue;
    }
    const slideNumber = extractSlideNumber(entry.name);
    const shapes = extractShapeFragments(xml).map((fragment) => ({
      fragment,
      name: extractShapeName(fragment),
      text: extractShapeText(fragment),
      ...extractShapeGeometry(fragment),
      hasVisibleEmptyShapeStyling: extractHasVisibleEmptyShapeStyling(fragment),
    }));
    const images = extractPictureFragments(xml).map((fragment) => {
      const relationshipId = extractRelationshipId(fragment);
      return {
        fragment,
        name: extractShapeName(fragment),
        ...extractShapeGeometry(fragment),
        ...(relationshipId ? { relationshipId } : {}),
      };
    });
    const editablePrimitiveCounts = countEditablePrimitives(xml, shapes, images);
    slides.push({
      path: entry.name,
      slideNumber,
      xml,
      text: extractShapeText(xml),
      shapes,
      images,
      editablePrimitiveCounts,
      hasImageOnlyTextFlatteningRisk: editablePrimitiveCounts.images > 0 && editablePrimitiveCounts.textBoxes === 0,
      imageRelationshipTargets: extractImageRelationshipTargets(buffer, entries, entryNames, entry.name, errors),
    });
  }

  return { ok: errors.length === 0, errors, entries, entryNames, slides };
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractZipEntries(buffer: Buffer, errors: string[]): OoxmlZipEntry[] {
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
    errors.push("PPTX ZIP central directory was not found.");
    return [];
  }

  const entryCount = readUInt16(buffer, endOffset + 10);
  const centralDirectoryOffset = readUInt32(buffer, endOffset + 16);
  const entries: OoxmlZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) {
      errors.push("PPTX ZIP central directory entry could not be parsed.");
      break;
    }
    const compressionMethod = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const fileNameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) {
      errors.push("PPTX ZIP central directory filename exceeds buffer bounds.");
      break;
    }
    entries.push({
      compressionMethod,
      compressedSize,
      localHeaderOffset,
      name: buffer.subarray(nameStart, nameEnd).toString("utf8"),
      uncompressedSize,
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: OoxmlZipEntry, errors: string[]): Buffer | null {
  const offset = entry.localHeaderOffset;
  if (readUInt32(buffer, offset) !== 0x04034b50) {
    errors.push(`PPTX ZIP local header missing for ${entry.name}.`);
    return null;
  }
  const fileNameLength = readUInt16(buffer, offset + 26);
  const extraLength = readUInt16(buffer, offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > buffer.length) {
    errors.push(`PPTX ZIP entry ${entry.name} exceeds buffer bounds.`);
    return null;
  }
  const compressed = buffer.subarray(dataOffset, dataEnd);
  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod !== 8) {
    errors.push(`PPTX ZIP entry ${entry.name} uses unsupported compression ${entry.compressionMethod}.`);
    return null;
  }
  try {
    return inflateRawSync(compressed);
  } catch (error) {
    errors.push(`PPTX ZIP entry ${entry.name} could not be inflated: ${error instanceof Error ? error.message : "unknown error"}.`);
    return null;
  }
}

function extractImageRelationshipTargets(buffer: Buffer, entries: OoxmlZipEntry[], entryNames: Set<string>, slidePath: string, errors: string[]) {
  const slideName = slidePath.split("/").at(-1) ?? "";
  const relationshipsPath = `ppt/slides/_rels/${slideName}.rels`;
  const relationshipsEntry = entries.find((entry) => entry.name === relationshipsPath);
  if (!relationshipsEntry) return [];
  const xml = readZipEntry(buffer, relationshipsEntry, errors)?.toString("utf8") ?? "";
  return Array.from(xml.matchAll(/<Relationship\b[^>]*\bType="[^"]*\/image"[^>]*\bTarget="([^"]+)"/g))
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .filter((target) => target.length > 0)
    .map((target) => normalizeRelationshipTarget("ppt/slides", target))
    .filter((target) => target.length > 0);
}

export function normalizeRelationshipTarget(baseDirectory: string, target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) return target.replace(/^\//, "");
  const parts = baseDirectory.split("/").concat(target.split("/"));
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function extractShapeFragments(slideXml: string): string[] {
  return Array.from(slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)).map((match) => match[0]);
}

function extractPictureFragments(slideXml: string): string[] {
  return Array.from(slideXml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)).map((match) => match[0]);
}

function extractGraphicFrameFragments(slideXml: string): string[] {
  return Array.from(slideXml.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)).map((match) => match[0]);
}

function countEditablePrimitives(slideXml: string, shapes: OoxmlSlideShape[], images: OoxmlSlideImage[]): OoxmlEditablePrimitiveCounts {
  const graphicFrames = extractGraphicFrameFragments(slideXml);
  return {
    textBoxes: shapes.filter((shape) => shape.text.length > 0).length,
    shapes: shapes.length,
    images: images.length,
    tables: graphicFrames.filter((fragment) => /<a:tbl\b/.test(fragment)).length,
    charts: graphicFrames.filter((fragment) => /<c:chart\b/.test(fragment)).length,
  };
}

function extractShapeText(xml: string): string {
  return Array.from(xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g))
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractShapeName(fragment: string): string {
  const match = fragment.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/);
  return match?.[1] ? decodeXmlEntities(match[1]) : "";
}

function extractRelationshipId(fragment: string): string | undefined {
  const match = fragment.match(/\br:embed="([^"]+)"/);
  return match?.[1] ? decodeXmlEntities(match[1]) : undefined;
}

function extractShapeGeometry(fragment: string): { x?: number; y?: number; cx?: number; cy?: number; prst: string } {
  const off = fragment.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/);
  const ext = fragment.match(/<a:ext\b[^>]*\bcx="(-?\d+)"[^>]*\bcy="(-?\d+)"/);
  const prst = fragment.match(/<a:prstGeom\b[^>]*\bprst="([^"]*)"/);
  if (!off?.[1] || !off[2] || !ext?.[1] || !ext[2]) return { prst: prst?.[1] ?? "" };
  return {
    x: Number(off[1]),
    y: Number(off[2]),
    cx: Number(ext[1]),
    cy: Number(ext[2]),
    prst: prst?.[1] ?? "",
  };
}

function extractHasVisibleEmptyShapeStyling(fragment: string): boolean {
  const hasFill = /<a:(?:solidFill|gradFill|pattFill)\b/.test(fragment);
  const line = fragment.match(/<a:ln\b[\s\S]*?<\/a:ln>/);
  return hasFill || Boolean(line && !/<a:noFill\b/.test(line[0]));
}

function extractSlideNumber(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/);
  return match?.[1] ? Number(match[1]) : 0;
}

function readUInt16(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0;
}

function readUInt32(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}
