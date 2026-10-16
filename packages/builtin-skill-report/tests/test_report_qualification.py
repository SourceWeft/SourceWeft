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
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from generate_report import generate
from report_schema import read_report
from verify_report import verify

FIXTURE = ROOT / 'tests/fixtures/long-table.source.json'


def pdf_navigation(xml, headings, page_texts, pdf_name='report.pdf'):
    """Require actual clickable PDF links, not just painted TOC labels/bookmarks.

    Poppler emits one page fragment per real link annotation. Only this PDF's
    internal page fragments count; remote/external files never satisfy a TOC.
    """
    if len(xml.encode('utf-8')) > 32 * 1024 * 1024:
        raise AssertionError('PDF navigation XML exceeds 32 MiB')
    document = ET.fromstring(xml)
    pages = {int(page.get('number')): page for page in document.findall('page')}
    if set(pages) != set(page_texts):
        raise AssertionError('PDF navigation XML pages differ from actual extracted pages')
    expected = [re.sub(r'\s+', '', heading) for heading in headings]
    found = {heading: [] for heading in expected}
    for page_no, page in pages.items():
        for link in page.iter('a'):
            label = re.sub(r'\s+', '', ''.join(link.itertext()))
            if label not in found:
                continue
            target = urlsplit(link.get('href', ''))
            allowed_names = ('', Path(pdf_name).stem + '.html', pdf_name)
            if target.scheme or target.netloc or target.query or target.path not in allowed_names or not re.fullmatch(r'[1-9][0-9]*', target.fragment):
                raise AssertionError(f'PDF contents link is not an internal page target: {label}')
            destination = int(target.fragment)
            if destination not in pages:
                raise AssertionError(f'PDF contents link target is outside the actual PDF: {label}')
            # Raw text alone could mistake a TOC label on page 1 for the actual
            # section heading. Also require a non-link text node on that page.
            body_nodes = [node for node in pages[destination].findall('text') if not list(node.iter('a'))]
            body_texts = [re.sub(r'\s+', '', ''.join(node.itertext())) for node in body_nodes]
            if label not in body_texts or label not in re.sub(r'\s+', '', page_texts[destination]):
                raise AssertionError(f'PDF contents link does not target the actual section page: {label}')
            found[label].append({'label': headings[expected.index(label)], 'sourcePage': page_no, 'targetPage': destination})
    if any(len(found[heading]) != 1 for heading in expected):
        raise AssertionError('PDF contents needs exactly one actual clickable internal link per section heading')
    return [found[heading][0] for heading in expected]


def qualify_navigation(source_path, pdf):
    source = read_report(source_path)
    headings = [section['heading'] for section in source['sections']]
    xml = subprocess.run(['pdftohtml', '-xml', '-stdout', '-i', str(pdf)], capture_output=True, text=True, check=True, timeout=30).stdout
    page_count = int(re.search(r'^Pages:\s+(\d+)$', subprocess.run(['pdfinfo', str(pdf)], capture_output=True, text=True, check=True, timeout=30).stdout, re.M).group(1))
    texts = {number: subprocess.run(['pdftotext', '-f', str(number), '-l', str(number), '-raw', str(pdf), '-'], capture_output=True, text=True, check=True, timeout=30).stdout for number in range(1, page_count + 1)}
    return pdf_navigation(xml, headings, texts, Path(pdf).name)


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
    navigation = qualify_navigation(source_path, pdf)
    result = {'passed': True, 'pdfContentsLinks': navigation, 'pageCount': count, 'tablePages': table_pages, 'recordCount': len(seen_ids), 'contentsTargets': expected_headings, 'pages': pages, 'pdfDigest': 'sha256:' + hashlib.sha256(pdf.read_bytes()).hexdigest(), 'visualReview': 'not_run'}
    (output / 'native-layout.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


class PdfNavigationContract(unittest.TestCase):
    def setUp(self):
        self.headings = ['记录清单', '检查限制']
        self.texts = {1: '目录 记录清单 检查限制 记录清单 正文', 2: '检查限制 正文'}
        self.xml = '<pdf2xml><page number="1"><text><a href="report.html#1">记录清单</a></text><text><a href="report.html#2">检查限制</a></text><text>记录清单</text><text>正文</text></page><page number="2"><text>检查限制</text><text>正文</text></page></pdf2xml>'

    def test_real_link_targets_must_match_actual_section_pages(self):
        result = pdf_navigation(self.xml, self.headings, self.texts)
        self.assertEqual([item['targetPage'] for item in result], [1, 2])
        self.assertEqual([item['label'] for item in result], self.headings)

    def test_painted_labels_external_links_and_duplicate_links_do_not_pass(self):
        variants = [
            re.sub(r'<a[^>]*>(.*?)</a>', r'\1', self.xml),
            self.xml.replace('report.html#2', 'https://example.test/report.html#2'),
            self.xml.replace('report.html#2', 'other.html#2'),
            self.xml.replace('report.html#2', 'report.html#99'),
            self.xml.replace('</page><page number="2">', '<text><a href="report.html#1">记录清单</a></text></page><page number="2">'),
        ]
        for xml in variants:
            with self.subTest(xml=xml):
                with self.assertRaises(AssertionError):
                    pdf_navigation(xml, self.headings, self.texts)

    def test_toc_label_on_wrong_target_page_is_not_a_body_heading(self):
        # The raw text of page 1 contains both TOC labels. An annotation to that
        # page cannot satisfy the second section, whose real heading is page 2.
        with self.assertRaisesRegex(AssertionError, 'actual section page'):
            pdf_navigation(self.xml.replace('report.html#2', 'report.html#1'), self.headings, self.texts)


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
    if len(sys.argv) == 4 and sys.argv[1] == '--qualify-navigation':
        print(json.dumps(qualify_navigation(sys.argv[2], sys.argv[3]), ensure_ascii=False))
    elif len(sys.argv) == 4 and sys.argv[1] == '--qualify-layout':
        print(json.dumps(qualify_layout(sys.argv[2], sys.argv[3]), ensure_ascii=False))
    else:
        unittest.main()
