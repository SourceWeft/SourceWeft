import { z } from "zod";
import { normalizeWhitespace } from "./base";
import type { ParsedPage } from "./types";

const recordSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePdf2MarkdownArtifacts(value: string): string {
  return value.replace(
    /<!--\s*Meanless:\s*([\s\S]*?)\s*-->/gi,
    (_match, content: string) => content.replace(/<br\s*\/?>/gi, "\n").trim(),
  );
}

function extractPageContent(page: unknown): string {
  const record = asRecord(page);
  if (!record) {
    return "";
  }

  const direct =
    asString(record.markdown) ||
    asString(record.md) ||
    asString(record.text) ||
    asString(record.content);
  if (direct) {
    return direct;
  }

  const layout = asRecord(record.layout);
  const blocks = Array.isArray(layout?.blocks)
    ? layout.blocks
    : Array.isArray(record.blocks)
      ? record.blocks
      : [];
  return blocks
    .map((block) => {
      const blockRecord = asRecord(block);
      return blockRecord
        ? asString(blockRecord.text) || asString(blockRecord.content)
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function extractPdf2MarkdownResult(resultJson: unknown): {
  readonly content: string;
  readonly pages: readonly ParsedPage[];
  readonly pageCount?: number;
} {
  const root = asRecord(resultJson);
  const data = asRecord(root?.data) ?? root;
  const result = asRecord(data?.result) ?? data;
  const directMarkdown =
    asString(result?.markdown) ||
    asString(result?.text) ||
    asString(result?.content);
  const pagesValue = Array.isArray(result?.pages) ? result.pages : [];
  const pages = pagesValue
    .map((page, index) => {
      const record = asRecord(page);
      const content = normalizeWhitespace(
        normalizePdf2MarkdownArtifacts(extractPageContent(page)),
      );
      if (!content) {
        return null;
      }

      const pageNumber =
        typeof record?.page_number === "number"
          ? record.page_number
          : typeof record?.pageNumber === "number"
            ? record.pageNumber
            : typeof record?.page_idx === "number"
              ? record.page_idx + 1
              : index + 1;

      return { pageNumber, content };
    })
    .filter((page): page is ParsedPage => page !== null);
  const content = normalizeWhitespace(
    normalizePdf2MarkdownArtifacts(
      directMarkdown || pages.map((page) => page.content).join("\n\n"),
    ),
  );
  const pageCount =
    typeof result?.page_count === "number"
      ? result.page_count
      : typeof data?.page_count === "number"
        ? data.page_count
        : pages.length || undefined;

  return {
    content,
    pages:
      pages.length > 0 ? pages : content ? [{ pageNumber: 1, content }] : [],
    pageCount,
  };
}
