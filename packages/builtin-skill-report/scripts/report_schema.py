"""Strict report-local input contract; standard library only, no evidence authentication."""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

MAX_SOURCE_BYTES = 2 * 1024 * 1024
REPORT_CITATION_TOKEN = re.compile(r"\[\s*S[1-9][0-9]*(?:\s*[,;，；]\s*S[1-9][0-9]*)*\s*\]", re.I)
TEXT_URL = re.compile(r"https?://[^\s<>\"'，。；！？（）【】]+", re.I)
RUNTIME_TOKEN = re.compile(r"\[c\d+\]|[\[【]\u200b?(?:citation\s*:|cite:)|||<citation", re.I)


def fail(message):
    raise ValueError(message)


def obj(value, required, optional=()):
    if not isinstance(value, dict):
        fail("Expected object")
    unknown = set(value) - set(required) - set(optional)
    missing = set(required) - set(value)
    if unknown or missing:
        fail(f"Invalid keys: unknown={sorted(unknown)}, missing={sorted(missing)}")
    return value


def text(value, label, limit=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail(f"Invalid {label}")
    if RUNTIME_TOKEN.search(value) or any(ord(c) < 32 and c not in '\n\t' for c in value):
        fail(f"Runtime citation marker/control character in {label}")
    return value


def statement_input_text(value, label, limit=4000):
    text(value, label, limit)
    # URL path/query brackets are literal source text, not report citations.
    # Mask them only for validation; never change the stored or rendered text.
    outside_urls = TEXT_URL.sub('', value)
    if REPORT_CITATION_TOKEN.search(outside_urls):
        fail('Inline report citation markers are not allowed in statement/cell text; use the citations array')
    return value


def array(value, label, maximum, minimum=1):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail(f"Invalid {label} count")
    return value


def citations(value, ids, required=False):
    array(value, "citations", 40, 1 if required else 0)
    if any(not isinstance(item, str) or item not in ids for item in value):
        fail("Unknown source citation")
    if len(set(value)) != len(value):
        fail("Duplicate citation")


def statement(value, ids, paragraph=False):
    obj(value, ["text", "kind", "citations"] + (["type"] if paragraph else []))
    statement_input_text(value["text"], "statement")
    if value["kind"] not in ("fact", "analysis", "recommendation"):
        fail("Invalid statement kind")
    citations(value["citations"], ids, value["kind"] == "fact")


def validate_report(report):
    obj(report, ["schemaVersion", "title", "language", "template", "summary", "sections", "sources"], ["audience"])
    if type(report["schemaVersion"]) is not int or report["schemaVersion"] != 1:
        fail("Unsupported report schemaVersion")
    text(report["title"], "title", 200)
    if report["language"] not in ("zh-CN", "en-US"):
        fail("Unsupported language")
    if report["template"] not in ("briefing", "comparison", "decision"):
        fail("Unsupported template")
    if "audience" in report:
        text(report["audience"], "audience", 200)
    ids = set()
    for source in array(report["sources"], "sources", 100):
        obj(source, ["id", "display"], ["provenance"])
        sid = source["id"]
        if not isinstance(sid, str) or not re.fullmatch(r"S[1-9][0-9]*", sid) or sid in ids:
            fail("Invalid or duplicate source id")
        ids.add(sid)
        display = obj(source["display"], ["title"], ["locator", "url"])
        text(display["title"], "source title", 300)
        if "locator" in display:
            text(display["locator"], "source locator", 500)
        if "url" in display:
            raw_url = text(display["url"], "source URL", 2000)
            url = urlsplit(raw_url)
            if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or any(c.isspace() for c in raw_url) or '\\' in raw_url:
                fail("Unsafe source URL")
        if "provenance" in source:
            provenance = obj(source["provenance"], [], ["sourceId", "documentId", "chunkId", "fileId", "scope", "revision", "locator"])
            if not provenance:
                fail("Empty provenance")
            for key, value in provenance.items():
                text(value, f"provenance {key}", 1000)
    for item in array(report["summary"], "summary", 10):
        statement(item, ids)
    sections = set()
    total_blocks = 0
    for section in array(report["sections"], "sections", 20):
        obj(section, ["id", "heading", "blocks"])
        sid = text(section["id"], "section id", 60)
        if not re.fullmatch(r"[a-z][a-z0-9-]*", sid) or sid in sections:
            fail("Invalid or duplicate section id")
        sections.add(sid)
        text(section["heading"], "heading", 200)
        blocks = array(section["blocks"], "blocks", 40)
        total_blocks += len(blocks)
        for block in blocks:
            if not isinstance(block, dict):
                fail("Expected block object")
            kind = block.get("type")
            if kind == "paragraph":
                statement(block, ids, paragraph=True)
            elif kind == "bullets":
                obj(block, ["type", "items"])
                for item in array(block["items"], "bullet items", 30):
                    statement(item, ids)
            elif kind == "table":
                obj(block, ["type", "columns", "rows"])
                columns = array(block["columns"], "columns", 10)
                for column in columns:
                    text(column, "column", 200)
                for row in array(block["rows"], "rows", 100):
                    if not isinstance(row, list) or len(row) != len(columns):
                        fail("Table dimension mismatch")
                    for cell in row:
                        obj(cell, ["text", "status", "citations"])
                        statement_input_text(cell["text"], "cell", 2000)
                        if cell["status"] not in ("value", "unknown", "conflict", "not_applicable"):
                            fail("Invalid cell status")
                        citations(cell["citations"], ids, cell["status"] in ("value", "conflict"))
            else:
                fail("Unsupported block type")
    if total_blocks > 100:
        fail("Report exceeds 100 blocks")
    return report


def read_report(source):
    path = Path(source)
    if path.stat().st_size > MAX_SOURCE_BYTES:
        fail("Report source exceeds 2 MiB")
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return validate_report(json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs))


def parse_formats(raw):
    formats = raw.split(',')
    if len(formats) != len(set(formats)) or "html" not in formats or any(item not in ("html", "md", "docx", "pdf") for item in formats):
        fail("Formats must be unique html,md,docx,pdf values and include html")
    return formats


def labels(report):
    return ({"summary": "摘要", "sources": "参考来源", "analysis": "分析", "recommendation": "建议", "unknown": "资料未说明", "conflict": "来源冲突", "not_applicable": "不适用"} if report["language"] == "zh-CN" else {"summary": "Summary", "sources": "Sources", "analysis": "Analysis", "recommendation": "Recommendation", "unknown": "Not stated", "conflict": "Conflicting sources", "not_applicable": "Not applicable"})


def statement_text(item, report):
    prefix = '' if item['kind'] == 'fact' else labels(report)[item['kind']] + ': '
    return prefix + item['text'] + ''.join(f' [{sid}]' for sid in item['citations'])


def cell_text(cell, report):
    status = '' if cell['status'] == 'value' else ' (' + labels(report)[cell['status']] + ')'
    return cell['text'] + status + ''.join(f' [{sid}]' for sid in cell['citations'])


def source_text(source):
    d = source['display']
    return f"[{source['id']}] {d['title']}" + (f" — {d['locator']}" if d.get('locator') else '') + (f" — {d['url']}" if d.get('url') else '')


def public_texts(report):
    """Expected public reading order, shared by format renderers and verification."""
    yield report['title']
    yield labels(report)['summary']
    for item in report['summary']:
        yield statement_text(item, report)
    for section in report['sections']:
        yield section['heading']
        for block in section['blocks']:
            if block['type'] == 'paragraph':
                yield statement_text(block, report)
            elif block['type'] == 'bullets':
                for item in block['items']:
                    yield statement_text(item, report)
            else:
                yield from block['columns']
                for row in block['rows']:
                    for cell in row:
                        yield cell_text(cell, report)
    yield labels(report)['sources']
    for source in report['sources']:
        yield source_text(source)
