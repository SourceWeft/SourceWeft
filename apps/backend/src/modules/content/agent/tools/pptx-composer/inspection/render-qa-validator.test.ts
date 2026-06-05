import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "vitest";
import { PptxGenJsRendererAdapter } from "../adapters";
import { basicProductOverviewFixture } from "../__fixtures__";
import { inspectOoxmlPptx } from "./ooxml-pptx-inspector";
import { validateRenderQa } from "./render-qa-validator";
import type { PresentationSourceV1 } from "../domain/schemas";

type ZipInput = {
  readonly name: string;
  readonly content: string | Buffer;
};

test("render QA passes valid composer PPTX buffer", async () => {
  const renderer = new PptxGenJsRendererAdapter();
  const rendered = await renderer.renderPresentation({ source: basicProductOverviewFixture });

  const report = validateRenderQa({ source: basicProductOverviewFixture, pptxBuffer: rendered.pptxBuffer });

  assert.equal(report.status, "passed");
  assert.equal(report.issues.length, 0);
  assert.equal(report.extensions?.phase, "render");
  assert.match(report.checkedAtIso ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("OOXML inspector reports native editable text primitives", async () => {
  const renderer = new PptxGenJsRendererAdapter();
  const rendered = await renderer.renderPresentation({ source: basicProductOverviewFixture });

  const inspection = inspectOoxmlPptx(rendered.pptxBuffer);

  assert.equal(inspection.ok, true);
  assert.equal(inspection.slides.length, basicProductOverviewFixture.slides.length);
  assert.ok(inspection.slides.every((slide) => slide.editablePrimitiveCounts.textBoxes > 0));
  assert.ok(inspection.slides.every((slide) => slide.hasImageOnlyTextFlatteningRisk === false));
});

test("render QA rejects corrupt non-PPTX buffer", () => {
  const report = validateRenderQa({ source: basicProductOverviewFixture, pptxBuffer: Buffer.from("not a pptx") });
  const codes = report.issues.map((issue) => issue.code);

  assert.equal(report.status, "failed");
  assert.ok(codes.includes("PPTX_PACKAGE_INVALID"));
  assert.ok(codes.includes("PPTX_BUFFER_TOO_SMALL"));
});

test("render QA rejects slide-count mismatch", async () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const rendered = await new PptxGenJsRendererAdapter().renderPresentation({ source });

  const report = validateRenderQa({ source: basicProductOverviewFixture, pptxBuffer: rendered.pptxBuffer });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "SLIDE_COUNT_MISMATCH"));
});

test("render QA fails a synthetic buffer with missing slide text run", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([slideXml("slide-cover", ["SourceWeft Product Overview"])]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "TEXT_RUN_MISSING" && issue.message.includes("Turn scattered")));
});

test("render QA rejects zero-size non-decorative shape", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([slideXml("slide-cover", ["SourceWeft Product Overview", "Turn scattered knowledge into grounded team outputs", "Self-hosted", "Multi-model", "Built for deep knowledge work"], { zeroSizeShape: true })]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "ZERO_SIZE_SHAPE"));
});


test("render QA rejects visible empty non-decorative shape", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([
    slideXml("slide-cover", ["SourceWeft Product Overview", "Turn scattered knowledge into grounded team outputs", "Self-hosted", "Multi-model", "Built for deep knowledge work"], {
      emptyShapes: [emptyShape("sw:content:empty-card", 914400, 914400, 914400, 914400)],
    }),
  ]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "EDITABLE_NATIVE_EMPTY_SHAPE"));
});

test("render QA rejects repeated empty geometry across at least three slides", () => {
  const source = { ...basicProductOverviewFixture, slides: basicProductOverviewFixture.slides.slice(0, 3) } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([
    slideXml("slide-cover", ["SourceWeft Product Overview", "Turn scattered knowledge into grounded team outputs", "Self-hosted", "Multi-model", "Built for deep knowledge work"], {
      emptyShapes: [emptyShape("sw:content:empty-card-1", 914400, 914400, 914400, 914400)],
    }),
    slideXml("slide-problem", ["Knowledge work is split across too many surfaces", "Sources live in disconnected systems", "Outputs lose citation context", "Team workflows are hard to repeat"], {
      emptyShapes: [emptyShape("sw:content:empty-card-2", 914400, 914400, 914400, 914400)],
    }),
    slideXml("slide-solution", ["SourceWeft gives agents a grounded workspace", "Connect sources", "Ask with citations", "Create reusable artifacts", "Extend with Skills"], {
      emptyShapes: [emptyShape("sw:content:empty-card-3", 914400, 914400, 914400, 914400)],
    }),
  ]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "EDITABLE_NATIVE_REPEATED_EMPTY_GEOMETRY"));
});

test("render QA allows visible empty chrome shapes", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([
    slideXml("slide-cover", ["SourceWeft Product Overview", "Turn scattered knowledge into grounded team outputs", "Self-hosted", "Multi-model", "Built for deep knowledge work"], {
      emptyShapes: [emptyShape("sw:chrome:decorative-frame", 914400, 914400, 914400, 914400)],
    }),
  ]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "passed");
  assert.ok(!report.issues.some((issue) => issue.code === "EDITABLE_NATIVE_EMPTY_SHAPE"));
});

test("render QA rejects broken image relationship", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([
    slideXml("slide-cover", ["SourceWeft Product Overview", "Turn scattered knowledge into grounded team outputs", "Self-hosted", "Multi-model", "Built for deep knowledge work"]),
  ], [{ name: "ppt/slides/_rels/slide1.xml.rels", content: relationshipXml("../media/missing.png") }]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "BROKEN_IMAGE_RELATIONSHIP"));
});

test("render QA rejects image-only flattened text output", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx([
    slideXml("slide-cover", [], {
      pictures: [picture("sw:content:slide-cover:flattened-text", 0, 0, 12188952, 6858000, "rId1")],
    }),
  ], [
    { name: "ppt/slides/_rels/slide1.xml.rels", content: relationshipXml("../media/flattened.png") },
    { name: "ppt/media/flattened.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "TEXT_FLATTENED_TO_IMAGE"));
});

test("OOXML inspector reports image primitives with dimensions", () => {
  const buffer = buildMinimalPptx([
    slideXml("slide-cover", ["Editable caption"], {
      pictures: [picture("sw:content:slide-cover:image-1", 914400, 457200, 1828800, 914400, "rId1")],
    }),
  ], [
    { name: "ppt/slides/_rels/slide1.xml.rels", content: relationshipXml("../media/image1.png") },
    { name: "ppt/media/image1.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);

  const inspection = inspectOoxmlPptx(buffer);
  const slide = inspection.slides[0];
  const image = slide?.images[0];

  assert.equal(inspection.ok, true);
  assert.equal(slide?.editablePrimitiveCounts.images, 1);
  assert.equal(image?.name, "sw:content:slide-cover:image-1");
  assert.equal(image?.cx, 1828800);
  assert.equal(image?.cy, 914400);
});

test("render QA rejects structurally empty slide", () => {
  const source = { ...basicProductOverviewFixture, slides: [basicProductOverviewFixture.slides[0]!] } satisfies PresentationSourceV1;
  const buffer = buildMinimalPptx(["<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:spTree /></p:cSld></p:sld>"]);

  const report = validateRenderQa({ source, pptxBuffer: buffer, options: { minByteLength: 1 } });

  assert.equal(report.status, "failed");
  assert.ok(report.issues.some((issue) => issue.code === "SLIDE_STRUCTURALLY_EMPTY"));
});

function buildMinimalPptx(slideXmlEntries: string[], extraEntries: ZipInput[] = []): Buffer {
  const entries: ZipInput[] = [
    { name: "[Content_Types].xml", content: "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\" />" },
    { name: "ppt/presentation.xml", content: "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" />" },
    { name: "ppt/_rels/presentation.xml.rels", content: "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\" />" },
    ...slideXmlEntries.map((content, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, content })),
    ...extraEntries,
  ];
  return zipEntries(entries);
}

type EmptyShapeOptions = {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
};

type PictureOptions = {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly relationshipId: string;
};

function slideXml(slideId: string, texts: string[], options: { readonly zeroSizeShape?: boolean; readonly emptyShapes?: EmptyShapeOptions[]; readonly pictures?: PictureOptions[] } = {}): string {
  const textShapes = texts.map((text, index) => shapeXml(`sw:content:${slideId}:text-${index + 1}`, text, 0, 0, 1000000, 300000)).join("");
  const zeroShape = options.zeroSizeShape ? shapeXml("sw:content:zero-card", "", 0, 0, 0, 300000) : "";
  const emptyShapes = (options.emptyShapes ?? []).map((shape) => shapeXml(shape.name, "", shape.x, shape.y, shape.cx, shape.cy, true)).join("");
  const pictures = (options.pictures ?? []).map((entry) => pictureXml(entry)).join("");
  return `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>${textShapes}${zeroShape}${emptyShapes}${pictures}</p:spTree></p:cSld></p:sld>`;
}

function shapeXml(name: string, text: string, x: number, y: number, cx: number, cy: number, visibleFill = false): string {
  const body = text ? `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody>` : "";
  const fill = visibleFill ? `<a:solidFill><a:srgbClr val="2563EB"/></a:solidFill>` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="${escapeXml(name)}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/>${fill}</p:spPr>${body}</p:sp>`;
}

function emptyShape(name: string, x: number, y: number, cx: number, cy: number): EmptyShapeOptions {
  return { name, x, y, cx, cy };
}

function picture(name: string, x: number, y: number, cx: number, cy: number, relationshipId: string): PictureOptions {
  return { name, x, y, cx, cy, relationshipId };
}

function pictureXml(input: PictureOptions): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="2" name="${escapeXml(input.name)}"/></p:nvPicPr><p:blipFill><a:blip r:embed="${escapeXml(input.relationshipId)}"/></p:blipFill><p:spPr><a:xfrm><a:off x="${input.x}" y="${input.y}"/><a:ext cx="${input.cx}" cy="${input.cy}"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic>`;
}

function relationshipXml(target: string): string {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXml(target)}"/></Relationships>`;
}

function zipEntries(entries: ZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.byteLength + name.byteLength + compressed.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
