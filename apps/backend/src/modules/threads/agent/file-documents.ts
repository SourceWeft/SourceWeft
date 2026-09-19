import { unzip, type Unzipped } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { posix, dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { FileLocator, FileRef } from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";

export type FileSegment = { locator: FileLocator; text: string };
export type FileDocument = { segments: FileSegment[]; warnings: string[] };

export async function renderFilePdfPage(
  bytes: Buffer,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: `${join(assets, "standard_fonts")}/`,
    cMapUrl: `${join(assets, "cmaps")}/`,
    cMapPacked: true,
    maxImageSize: 40_000_000,
  });
  const abort = () => {
    void task.destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const document = await task.promise;
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > document.numPages
    )
      throw new ContentError(
        400,
        "INVALID_PAGE",
        "Choose an existing PDF page.",
      );
    const page = await document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 2048 / base.width, 2048 / base.height);
    if (!Number.isFinite(scale) || scale <= 0 || scale < 0.05)
      throw new ContentError(
        413,
        "PAGE_TOO_LARGE",
        "This page exceeds the visual reading dimensions.",
      );
    const viewport = page.getViewport({ scale });
    const factory = document.canvasFactory as {
      create(
        width: number,
        height: number,
      ): { canvas: { toBuffer(type: string): Buffer }; context: unknown };
      destroy(target: unknown): void;
    };
    const target = factory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    try {
      if (typeof target.canvas.toBuffer !== "function")
        throw new ContentError(
          409,
          "PDF_RENDERER_UNAVAILABLE",
          "The PDF image renderer is unavailable.",
        );
      await page.render({
        viewport,
        canvas: target.canvas as never,
        canvasContext: target.context as never,
      }).promise;
      signal?.throwIfAborted();
      return Buffer.from(target.canvas.toBuffer("image/png"));
    } finally {
      factory.destroy(target);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}
type Xml = Record<string, unknown>;

function name(node: Xml) {
  return Object.keys(node).find((key) => key !== ":@" && key !== "#text") ?? "";
}
function local(tag: string) {
  return tag.split(":").pop()!;
}
function attrs(node: Xml): Record<string, string> {
  return (node[":@"] ?? {}) as Record<string, string>;
}
function attr(node: Xml, key: string) {
  return Object.entries(attrs(node)).find(
    ([name]) => local(name.replace(/^@_/, "")) === key,
  )?.[1];
}
function relationId(node: Xml) {
  return Object.entries(attrs(node)).find(([key]) => key.endsWith(":id"))?.[1];
}
function children(node: Xml): Xml[] {
  const value = node[name(node)];
  return Array.isArray(value) ? value : [];
}
function elements(nodes: Xml[], tag: string): Xml[] {
  const result: Xml[] = [],
    pending = [...nodes].reverse();
  let visited = 0;
  while (pending.length) {
    if (++visited > 500_000)
      throw new ContentError(
        413,
        "DOCUMENT_LIMIT",
        "Document XML exceeds the node budget.",
      );
    const node = pending.pop()!;
    if (local(name(node)) === tag) result.push(node);
    pending.push(...children(node).slice().reverse());
  }
  return result;
}
function text(nodes: Xml[]): string {
  const output: string[] = [],
    pending = [...nodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (node["#text"] !== undefined) output.push(String(node["#text"]));
    if (["tab", "br", "cr"].includes(local(name(node))))
      output.push(local(name(node)) === "tab" ? "\t" : "\n");
    pending.push(...children(node).slice().reverse());
  }
  return output.join("");
}

function paragraphText(node: Xml): string {
  const output: string[] = [],
    pending = [...children(node)].reverse();
  while (pending.length) {
    const next = pending.pop()!;
    const tag = local(name(next));
    if (tag === "t") output.push(text(children(next)));
    else if (tag === "tab") output.push("\t");
    else if (tag === "br" || tag === "cr") output.push("\n");
    else if (!tag.endsWith("Pr") && tag !== "rPh")
      pending.push(...children(next).slice().reverse());
  }
  return output.join("");
}

function xml(parts: Unzipped, path: string): Xml[] {
  const bytes = parts[path];
  if (!bytes)
    throw new ContentError(
      422,
      "DOCUMENT_PART_MISSING",
      `Document part ${path} is unavailable.`,
    );
  const encoding =
    bytes[0] === 255 && bytes[1] === 254
      ? "utf-16le"
      : bytes[0] === 254 && bytes[1] === 255
        ? "utf-16be"
        : "utf-8";
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new ContentError(
      422,
      "DOCUMENT_XML_DENIED",
      "Document XML entities are not supported.",
    );
  if (XMLValidator.validate(source) !== true)
    throw new ContentError(
      422,
      "DOCUMENT_XML_INVALID",
      "Document XML is malformed.",
    );
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: true,
  }).parse(source) as Xml[];
}

async function officeParts(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Unzipped> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let total = 0;
    let stop = () => {};
    const abort = () => {
      stop();
      reject(signal?.reason ?? new Error("Document read cancelled"));
    };
    stop = unzip(
      bytes,
      {
        filter: (entry) => {
          if (!/^(word|ppt|xl)\/.+\.(xml|rels)$/.test(entry.name)) return false;
          total += entry.originalSize;
          if (entry.originalSize > 8 * 1024 * 1024 || total > 40 * 1024 * 1024)
            throw new ContentError(
              413,
              "DOCUMENT_LIMIT",
              "Document XML exceeds the extraction budget.",
            );
          return true;
        },
      },
      (error, parts) => {
        signal?.removeEventListener("abort", abort);
        if (error)
          reject(
            new ContentError(
              422,
              "DOCUMENT_ZIP_INVALID",
              "Document archive is invalid.",
            ),
          );
        else resolve(parts);
      },
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function relationships(parts: Unzipped, path: string, base: string) {
  return new Map(
    elements(xml(parts, path), "Relationship")
      .filter((node) => attr(node, "TargetMode") !== "External")
      .map((node) => [
        attr(node, "Id"),
        (attr(node, "Target")?.startsWith("/")
          ? attr(node, "Target")!
          : posix.join(base, attr(node, "Target") ?? "")
        ).replace(/^\//, ""),
      ]),
  );
}

export async function readFileDocument(
  file: FileRef,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<FileDocument> {
  signal?.throwIfAborted();
  if (file.mimeType === "application/pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
    });
    const abort = () => {
      void task.destroy();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const document = await task.promise;
      if (document.numPages > 500)
        throw new ContentError(
          413,
          "DOCUMENT_LIMIT",
          "Documents are limited to 500 pages per read.",
        );
      const segments: FileSegment[] = [],
        warnings: string[] = [];
      for (let page = 1; page <= document.numPages; page += 1) {
        signal?.throwIfAborted();
        const handle = await document.getPage(page);
        const content = await handle.getTextContent();
        const value = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("")
          .trim();
        segments.push({ locator: { kind: "page", page }, text: value });
        if (!value)
          warnings.push(
            `Page ${page} has no extractable text; visual reading or OCR is required.`,
          );
        handle.cleanup();
      }
      return { segments, warnings };
    } finally {
      signal?.removeEventListener("abort", abort);
      await task.destroy();
    }
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "docx" || extension === "pptx" || extension === "xlsx") {
    const parts = await officeParts(bytes, signal);
    signal?.throwIfAborted();
    if (extension === "docx") {
      const nodes = xml(parts, "word/document.xml");
      const segments = elements(nodes, "p").map((node, index) => ({
        locator: { kind: "paragraph" as const, index },
        text: paragraphText(node),
      }));
      const warnings = Object.keys(parts).some((path) =>
        /word\/(footnotes|endnotes|header\d+|footer\d+)\.xml/.test(path),
      )
        ? [
            "Main document paragraphs only; headers, footers and notes are not included in this text view.",
          ]
        : [];
      return { segments, warnings };
    }
    if (extension === "pptx") {
      const refs = relationships(
        parts,
        "ppt/_rels/presentation.xml.rels",
        "ppt",
      );
      const slides = elements(xml(parts, "ppt/presentation.xml"), "sldId");
      return {
        segments: slides.map((node, index) => {
          const target = refs.get(relationId(node));
          if (!target)
            throw new ContentError(
              422,
              "DOCUMENT_PART_MISSING",
              "A slide relationship is missing.",
            );
          return {
            locator: { kind: "slide", slide: index + 1 },
            text: elements(xml(parts, target), "t")
              .map((node) => text(children(node)))
              .join("\n"),
          };
        }),
        warnings: Object.keys(parts).some((path) =>
          path.startsWith("ppt/notesSlides/"),
        )
          ? ["Speaker notes are not included in this slide text view."]
          : [],
      };
    }
    const refs = relationships(parts, "xl/_rels/workbook.xml.rels", "xl");
    const shared = parts["xl/sharedStrings.xml"]
      ? elements(xml(parts, "xl/sharedStrings.xml"), "si").map(paragraphText)
      : [];
    const segments: FileSegment[] = [];
    for (const sheet of elements(xml(parts, "xl/workbook.xml"), "sheet")) {
      const target = refs.get(relationId(sheet));
      if (!target)
        throw new ContentError(
          422,
          "DOCUMENT_PART_MISSING",
          "A worksheet relationship is missing.",
        );
      for (const cell of elements(xml(parts, target), "c")) {
        const address = attr(cell, "r");
        if (!address || !/^[A-Z]{1,3}[1-9][0-9]*$/.test(address))
          throw new ContentError(
            422,
            "CELL_ADDRESS_UNAVAILABLE",
            "A worksheet cell has no supported address.",
          );
        const type = attr(cell, "t");
        const value = elements(children(cell), "v")
          .map((node) => text(children(node)))
          .join("");
        const formula = elements(children(cell), "f")
          .map((node) => text(children(node)))
          .join("");
        const content =
          type === "s"
            ? shared[Number(value)]
            : type === "inlineStr"
              ? paragraphText(cell)
              : value;
        if (content === undefined)
          throw new ContentError(
            422,
            "CELL_VALUE_UNAVAILABLE",
            "A shared cell value is unavailable.",
          );
        segments.push({
          locator: {
            kind: "cells",
            sheet: attr(sheet, "name") ?? "Sheet",
            range: address,
          },
          text: JSON.stringify({
            value: content,
            ...(formula ? { formula, valueKind: "cached" } : {}),
            ...(attr(cell, "s") ? { styleIndex: attr(cell, "s") } : {}),
          }),
        });
        if (segments.length > 100_000)
          throw new ContentError(
            413,
            "DOCUMENT_LIMIT",
            "The workbook exceeds the cell extraction budget.",
          );
      }
    }
    return {
      segments,
      warnings: [
        "Cell values are stored values; formulas are not evaluated and date/number styles are not applied.",
      ],
    };
  }
  if (!file.capabilities.readText && extension !== "csv")
    throw new ContentError(
      415,
      "DOCUMENT_UNSUPPORTED",
      "This file type does not support text extraction.",
    );
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (content.includes("\0"))
    throw new ContentError(
      415,
      "DOCUMENT_UNSUPPORTED",
      "Binary content cannot be read as text.",
    );
  if (extension === "csv")
    return { segments: csvSegments(content), warnings: [] };
  return {
    segments: content.split(/\r?\n/).map((line, index) => ({
      locator: { kind: "lines", start: index + 1, end: index + 1 },
      text: line,
    })),
    warnings: [],
  };
}

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function csvSegments(content: string): FileSegment[] {
  const segments: FileSegment[] = [];
  let value = "",
    row = 1,
    column = 0,
    quoted = false,
    closed = false;
  const emit = () => {
    if (segments.length >= 100_000)
      throw new ContentError(
        413,
        "DOCUMENT_LIMIT",
        "CSV exceeds the cell budget.",
      );
    segments.push({
      locator: {
        kind: "cells",
        sheet: "CSV",
        range: `${columnName(column++)}${row}`,
      },
      text: value,
    });
    value = "";
    closed = false;
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else value += char;
    } else if (char === ",") emit();
    else if (char === "\n" || char === "\r") {
      emit();
      row += 1;
      column = 0;
      if (char === "\r" && content[index + 1] === "\n") index += 1;
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"')
      throw new ContentError(422, "CSV_INVALID", "CSV quoting is invalid.");
    else value += char;
  }
  if (quoted)
    throw new ContentError(
      422,
      "CSV_INVALID",
      "CSV contains an unterminated quoted cell.",
    );
  if ((content && !/[\r\n]$/.test(content)) || value || closed) emit();
  return segments;
}
