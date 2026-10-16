"""Frozen-source revision tests and actual native PDF layout qualification.

Host tests use stdlib HTML/Markdown only. The explicit --qualify-layout command
requires the provisioned sandbox's real LibreOffice PDF and Poppler tools.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from generate_report import generate
from report_schema import read_report
from verify_report import verify

FIXTURE = ROOT / 'tests/fixtures/long-table.source.json'


def qualify_layout(source_path, output_path):
    """Check real PDF pages; XML flags alone do not prove repeated headers."""
    source = read_report(source_path)
    output = Path(output_path)
    pdf = output / 'report.pdf'
    namespace = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    with zipfile.ZipFile(output / 'report.docx') as archive:
        document = ET.fromstring(archive.read('word/document.xml'))
    expected_headings = [section['heading'] for section in source['sections']]
    links = list(document.iter(namespace + 'hyperlink'))
    anchors = [link.get(namespace + 'anchor') for link in links]
    bookmarks = list(document.iter(namespace + 'bookmarkStart'))
    bookmark_names = [bookmark.get(namespace + 'name') for bookmark in bookmarks]
    if len(anchors) != len(expected_headings) or len(set(anchors)) != len(anchors) or anchors != bookmark_names:
        raise AssertionError('DOCX contents must link once to each actual section bookmark')
    if [''.join(node.text or '' for node in link.iter(namespace + 't')) for link in links] != expected_headings:
        raise AssertionError('DOCX contents link labels differ from actual section headings')
    targets = []
    for paragraph in document.iter(namespace + 'p'):
        if paragraph.find(namespace + 'bookmarkStart') is not None:
            targets.append(''.join(node.text or '' for node in paragraph.iter(namespace + 't')))
    if targets != expected_headings:
        raise AssertionError('DOCX contents bookmarks do not target the corresponding section headings')
    info = subprocess.run(['pdfinfo', str(pdf)], capture_output=True, text=True, check=True, timeout=30).stdout
    page_match = re.search(r'^Pages:\s+(\d+)$', info, re.M)
    if not page_match:
        raise AssertionError('pdfinfo did not report the actual page count')
    count = int(page_match.group(1))
    if count < 2:
        raise AssertionError('Long-table fixture did not actually cross pages')
    block = source['sections'][0]['blocks'][0]
    expected_ids = [row[0]['text'] for row in block['rows']]
    seen_ids = []
    table_pages = []
    pages = []
    for page_no in range(1, count + 1):
        text = subprocess.run(['pdftotext', '-f', str(page_no), '-l', str(page_no), '-raw', str(pdf), '-'], capture_output=True, text=True, check=True, timeout=30).stdout
        page_fields = re.findall(r'^Page\s+(\d+)\s*/\s*(\d+)\s*$', text, re.M)
        if page_fields != [(str(page_no), str(count))]:
            raise AssertionError(f'Page {page_no}: expected exactly Page {page_no} / {count}, got {page_fields}')
        ids = re.findall(r'ROW\d{3}', text)
        if ids:
            flat = re.sub(r'\s+', '', text)
            if not all(re.sub(r'\s+', '', heading) in flat for heading in block['columns']):
                raise AssertionError(f'Page {page_no}: actual table text is missing a repeated column heading')
            table_pages.append(page_no)
            seen_ids.extend(ids)
        pages.append({'page': page_no, 'footer': f'Page {page_no} / {count}', 'recordIds': ids})
    if len(table_pages) < 2:
        raise AssertionError('Records must occur on at least two actual pages')
    if table_pages[0] != 1:
        raise AssertionError('This short summary/contents fixture must begin its table on page 1 rather than leave most of the page blank')
    if seen_ids != expected_ids:
        raise AssertionError(f'Rows changed, repeated, missing or reordered: {seen_ids}')
    result = {'passed': True, 'pageCount': count, 'tablePages': table_pages, 'recordCount': len(seen_ids), 'contentsTargets': expected_headings, 'pages': pages, 'pdfDigest': 'sha256:' + hashlib.sha256(pdf.read_bytes()).hexdigest(), 'visualReview': 'not_run'}
    (output / 'native-layout.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


class FrozenPresentationQualification(unittest.TestCase):
    def test_custom_presentation_survives_frozen_restore_and_content_revision(self):
        source = read_report(FIXTURE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / 'original'
            generate(FIXTURE, original, ['html', 'md'])
            # Pure host test uses the draft; native qualification runs the real
            # bundler, browser, DOCX and PDF separately.
            (original / 'report.html').write_bytes((original / 'draft.html').read_bytes())
            self.assertTrue(verify(FIXTURE, original, ['html', 'md'])['passed'])
            before = {name: hashlib.sha256((original / name).read_bytes()).hexdigest() for name in ('report.source.json', 'report.html', 'report.md')}
            restored = read_report(original / 'report.source.json')
            self.assertEqual(restored, source)
            restored['summary'][0]['text'] += ' 修订只增加这句测试说明。'
            revision_source = root / 'revision.source.json'
            revision_source.write_text(json.dumps(restored, ensure_ascii=False))
            revised = root / 'revised'
            generate(revision_source, revised, ['html', 'md'])
            (revised / 'report.html').write_bytes((revised / 'draft.html').read_bytes())
            self.assertTrue(verify(revision_source, revised, ['html', 'md'])['passed'])
            after = read_report(revised / 'report.source.json')
            self.assertEqual(after['presentation'], source['presentation'])
            expected = copy.deepcopy(source)
            expected['summary'][0]['text'] = restored['summary'][0]['text']
            self.assertEqual(after, expected)
            for name, digest in before.items():
                self.assertEqual(hashlib.sha256((original / name).read_bytes()).hexdigest(), digest)
                self.assertNotEqual(hashlib.sha256((revised / name).read_bytes()).hexdigest(), digest)

    def test_legacy_source_does_not_gain_presentation_fields_on_roundtrip(self):
        fixture = ROOT / 'tests/fixtures/comparison.source.json'
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'legacy'
            generate(fixture, output, ['html', 'md'])
            restored = read_report(output / 'report.source.json')
            self.assertEqual(restored, read_report(fixture))
            self.assertNotIn('presentation', restored)


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--qualify-layout':
        print(json.dumps(qualify_layout(sys.argv[2], sys.argv[3]), ensure_ascii=False))
    else:
        unittest.main()
