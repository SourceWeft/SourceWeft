"""Strict report-local input contract; standard library only, no evidence authentication."""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

MAX_SOURCE_BYTES = 2 * 1024 * 1024
REPORT_CITATION_TOKEN = re.compile(r"\[\s*S[1-9][0-9]*(?:\s*[,;，；]\s*S[1-9][0-9]*)*\s*\]", re.I)
TEXT_URL = re.compile(r"https?://[^\s<>\"'，。；！？（）【】]+", re.I)
PRESENTATION_DEFAULTS = {"mobileDensity": "standard", "tableOfContents": False, "pageNumbers": False, "citationLayout": "inline"}
RUNTIME_TOKEN = re.compile(r"\[c\d+\]|[\[【]\u200b?(?:citation\s*:|cite:)|||<citation", re.I)
# Legacy provenance: free-form observed strings without a `kind` discriminator.
LEGACY_PROVENANCE_KEYS = ("sourceId", "documentId", "chunkId", "fileId", "scope", "revision", "locator")
# Resolvable provenance mirrors the host /files footnotes and packages/contracts/src/files.ts.
PROVENANCE_KINDS = ("chunk", "file", "external")
FILE_BACKENDS = ("cloud_vfs", "local_fs")
FILE_REVISION = re.compile(r"sha256:[a-f0-9]{64}")
FILE_LOCATOR_FIELDS = {"lines": (["start", "end"], []), "page": (["page"], []), "slide": (["slide"], []), "paragraph": (["index"], ["heading"]), "cells": (["sheet", "range"], []), "image": ([], [])}


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


def safe_url(raw_url, label):
    text(raw_url, label, 2000)
    url = urlsplit(raw_url)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or any(c.isspace() for c in raw_url) or '\\' in raw_url:
        fail(f"Unsafe {label}")
    return raw_url


def identifier(value, label, limit=200):
    """Observed host identity copied verbatim; bounded, non-blank, no controls."""
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        fail(f"Invalid {label}")
    return value


def positive_int(value, label, minimum=1):
    if type(value) is not int or value < minimum:
        fail(f"Invalid {label}; expected an integer >= {minimum}")
    return value


def relative_path(value, label):
    # Mirrors fileRelativePathSchema: beneath the root, no backslash/control, no '.'/'..' parts.
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or value.startswith('/') or any(c == '\\' or ord(c) < 32 or ord(c) == 127 for c in value) or any(part in ('', '.', '..') for part in value.split('/')):
        fail(f"Invalid {label}; expected a relative file path beneath the authorized root")
    return value


def file_locator(value):
    """Mirrors fileLocatorSchema in packages/contracts/src/files.ts."""
    kind = value.get("kind") if isinstance(value, dict) else None
    if not isinstance(kind, str) or kind not in FILE_LOCATOR_FIELDS:
        fail("Invalid provenance locator kind")
    required, optional = FILE_LOCATOR_FIELDS[kind]
    obj(value, ["kind"] + required, optional)
    if kind == "lines":
        if positive_int(value["end"], "locator end") < positive_int(value["start"], "locator start"):
            fail("Invalid locator line range")
    elif kind in ("page", "slide"):
        positive_int(value[kind], f"locator {kind}")
    elif kind == "paragraph":
        positive_int(value["index"], "locator index", 0)
        if "heading" in value:
            identifier(value["heading"], "locator heading", 1000)
    elif kind == "cells":
        identifier(value["sheet"], "locator sheet", 256)
        identifier(value["range"], "locator range", 64)
    return value


def provenance_object(provenance):
    """Private provenance: strict per-kind shapes, or the legacy free-form strings."""
    if not isinstance(provenance, dict):
        fail("Expected provenance object")
    if "kind" not in provenance:
        obj(provenance, [], LEGACY_PROVENANCE_KEYS)
        if not provenance:
            fail("Empty provenance")
        for key, value in provenance.items():
            text(value, f"provenance {key}", 1000)
        return provenance
    kind = provenance["kind"]
    if kind == "chunk":
        obj(provenance, ["kind", "sourceId", "documentId", "chunkId"], ["chunkNo", "path"])
        for key in ("sourceId", "documentId", "chunkId"):
            identifier(provenance[key], f"provenance {key}")
        if "chunkNo" in provenance:
            # Host chunk numbers are 0-based (ingest index); the footnote copies them verbatim.
            positive_int(provenance["chunkNo"], "provenance chunkNo", 0)
        if "path" in provenance:
            # Footnote-emitted document path; copied verbatim, never used for navigation.
            identifier(provenance["path"], "provenance path", 1000)
    elif kind == "file":
        obj(provenance, ["kind", "workspaceId", "threadId", "backendKind", "fileId", "relativePath", "revision", "locator"])
        for key in ("workspaceId", "threadId", "fileId"):
            identifier(provenance[key], f"provenance {key}")
        if provenance["backendKind"] not in FILE_BACKENDS:
            fail("Invalid provenance backendKind")
        relative_path(provenance["relativePath"], "provenance relativePath")
        if not isinstance(provenance["revision"], str) or not FILE_REVISION.fullmatch(provenance["revision"]):
            fail("Invalid provenance revision; expected sha256:<64 hex>")
        file_locator(provenance["locator"])
    elif kind == "external":
        obj(provenance, ["kind", "url"])
        safe_url(provenance["url"], "provenance url")
    else:
        fail("Unsupported provenance kind")
    return provenance


def provenance_status(source):
    """Structural classification only: resolvable (typed kind), legacy (free-form), missing."""
    provenance = source.get("provenance")
    if provenance is None:
        return "missing"
    return "resolvable" if provenance.get("kind") in PROVENANCE_KINDS else "legacy"


def provenance_counts(report):
    counts = {"resolvable": 0, "legacy": 0, "missing": 0}
    for source in report["sources"]:
        counts[provenance_status(source)] += 1
    return counts


def statement(value, ids, paragraph=False):
    obj(value, ["text", "kind", "citations"] + (["type"] if paragraph else []))
    statement_input_text(value["text"], "statement")
    if value["kind"] not in ("fact", "analysis", "recommendation"):
        fail("Invalid statement kind")
    citations(value["citations"], ids, value["kind"] == "fact")


def validate_report(report):
    obj(report, ["schemaVersion", "title", "language", "template", "summary", "sections", "sources"], ["audience", "presentation"])
    if type(report["schemaVersion"]) is not int or report["schemaVersion"] != 1:
        fail("Unsupported report schemaVersion")
    text(report["title"], "title", 200)
    if report["language"] not in ("zh-CN", "en-US"):
        fail("Unsupported language")
    if report["template"] not in ("briefing", "comparison", "decision"):
        fail("Unsupported template")
    if "audience" in report:
        text(report["audience"], "audience", 200)
    if "presentation" in report:
        presentation = obj(report["presentation"], [], PRESENTATION_DEFAULTS)
        for key in ("tableOfContents", "pageNumbers"):
            if key in presentation and type(presentation[key]) is not bool:
                fail(f"Invalid presentation {key}; expected boolean")
        for key, allowed in (("mobileDensity", ("standard", "compact")), ("citationLayout", ("inline", "source-notes"))):
            if key in presentation and (not isinstance(presentation[key], str) or presentation[key] not in allowed):
                fail(f"Invalid presentation {key}")
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
            safe_url(display["url"], "source URL")
        if "provenance" in source:
            provenance_object(source["provenance"])
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
    return ({"contents": "目录", "source_note": "来源", "summary": "摘要", "sources": "参考来源", "analysis": "分析", "recommendation": "建议", "unknown": "资料未说明", "conflict": "来源冲突", "not_applicable": "不适用"} if report["language"] == "zh-CN" else {"contents": "Contents", "source_note": "Sources", "summary": "Summary", "sources": "Sources", "analysis": "Analysis", "recommendation": "Recommendation", "unknown": "Not stated", "conflict": "Conflicting sources", "not_applicable": "Not applicable"})


def statement_text(item, report):
    prefix = '' if item['kind'] == 'fact' else labels(report)[item['kind']] + ': '
    return prefix + item['text'] + ''.join(f' [{sid}]' for sid in item['citations'])


def cell_text(cell, report):
    status = '' if cell['status'] == 'value' else ' (' + labels(report)[cell['status']] + ')'
    return cell['text'] + status + ''.join(f' [{sid}]' for sid in cell['citations'])


def source_text(source):
    d = source['display']
    return f"[{source['id']}] {d['title']}" + (f" — {d['locator']}" if d.get('locator') else '') + (f" — {d['url']}" if d.get('url') else '')


def effective_presentation(report):
    """Resolve layout defaults without changing the frozen editable source."""
    return {**PRESENTATION_DEFAULTS, **report.get('presentation', {})}


def contents_entries(report):
    """Only actual section identities/headings become the optional static TOC."""
    return [(section['id'], section['heading']) for section in report['sections']] if effective_presentation(report)['tableOfContents'] else []


def citation_parts(body, citation_ids, report):
    suffix = ''.join(f' [{sid}]' for sid in citation_ids)
    if effective_presentation(report)['citationLayout'] == 'inline':
        return body + suffix, None
    note = labels(report)['source_note'] + ':' + suffix if citation_ids else None
    return body, note


def statement_body(item, report):
    """Statement text with its kind label, before any citation markers."""
    prefix = '' if item['kind'] == 'fact' else labels(report)[item['kind']] + ': '
    return prefix + item['text']


def cell_body(cell, report):
    """Cell text with its status label, before any citation markers."""
    status = '' if cell['status'] == 'value' else ' (' + labels(report)[cell['status']] + ')'
    return cell['text'] + status


def statement_parts(item, report):
    return citation_parts(statement_body(item, report), item['citations'], report)


def cell_parts(cell, report):
    return citation_parts(cell_body(cell, report), cell['citations'], report)


def public_texts(report):
    """Expected public reading order, shared by format renderers and verification."""
    def visible(parts):
        return (part for part in parts if part is not None)
    yield report['title']
    yield labels(report)['summary']
    for item in report['summary']:
        yield from visible(statement_parts(item, report))
    entries = contents_entries(report)
    if entries:
        yield labels(report)['contents']
        for _, heading in entries:
            yield heading
    for section in report['sections']:
        yield section['heading']
        for block in section['blocks']:
            if block['type'] == 'paragraph':
                yield from visible(statement_parts(block, report))
            elif block['type'] == 'bullets':
                for item in block['items']:
                    yield from visible(statement_parts(item, report))
            else:
                yield from block['columns']
                for row in block['rows']:
                    for cell in row:
                        yield from visible(cell_parts(cell, report))
    yield labels(report)['sources']
    for source in report['sources']:
        yield source_text(source)
