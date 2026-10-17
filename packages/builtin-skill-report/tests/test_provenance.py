"""Private provenance shapes, verify counts and display-level HTML citation anchors (stdlib only)."""
import copy
from html import escape
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from report_schema import read_report, validate_report, provenance_status, provenance_counts, public_texts, source_text
from generate_report import html_document, markdown_document, generate
from verify_report import verify, PublicHTML, normalized

FIXTURE = ROOT / 'tests/fixtures/comparison.source.json'
SHA = 'sha256:' + 'a' * 64
CHUNK = {'kind': 'chunk', 'sourceId': 'src_01', 'documentId': 'doc_01', 'chunkId': 'chk_01', 'chunkNo': 3}
FILE = {'kind': 'file', 'workspaceId': 'ws_01', 'threadId': 'th_01', 'backendKind': 'cloud_vfs', 'fileId': 'file_01',
        'relativePath': 'notes/a.md', 'revision': SHA, 'locator': {'kind': 'lines', 'start': 1, 'end': 3}}
EXTERNAL = {'kind': 'external', 'url': 'https://example.test/doc?page=2'}


class ProvenanceSchemaTest(unittest.TestCase):
    def setUp(self):
        self.report = read_report(FIXTURE)

    def with_provenance(self, provenance, index=0):
        report = copy.deepcopy(self.report)
        if provenance is None:
            report['sources'][index].pop('provenance')
        else:
            report['sources'][index]['provenance'] = provenance
        return report

    def accept(self, provenance):
        report = self.with_provenance(provenance)
        self.assertIs(validate_report(report), report)
        return report

    def reject(self, provenance, message=None):
        with self.assertRaisesRegex(ValueError, message or '.'):
            validate_report(self.with_provenance(provenance))

    def test_chunk_shape(self):
        self.accept(CHUNK)
        without_no = {k: v for k, v in CHUNK.items() if k != 'chunkNo'}
        self.assertEqual(provenance_status(self.accept(without_no)['sources'][0]), 'resolvable')
        self.accept({**CHUNK, 'chunkNo': 0})
        self.reject({**CHUNK, 'chunkNo': -1}, 'chunkNo')
        self.reject({**CHUNK, 'chunkNo': '3'}, 'chunkNo')
        self.reject({**CHUNK, 'chunkNo': True}, 'chunkNo')
        self.reject({**CHUNK, 'chunkId': ''}, 'chunkId')
        self.reject({**CHUNK, 'chunkId': 'x' * 201}, 'chunkId')
        self.reject({**CHUNK, 'sourceId': 'a\x00b'}, 'sourceId')
        self.reject({k: v for k, v in CHUNK.items() if k != 'documentId'}, 'missing')
        # The footnote may emit `path`; a verbatim copy validates, other extras still do not.
        self.assertEqual(provenance_status(self.accept({**CHUNK, 'path': 'folder/doc.md'})['sources'][0]), 'resolvable')
        self.reject({**CHUNK, 'path': ''}, 'path')
        self.reject({**CHUNK, 'path': 'a\x00b'}, 'path')
        self.reject({**CHUNK, 'path': 'x' * 1001}, 'path')
        self.reject({**CHUNK, 'path': 3}, 'path')
        self.reject({**CHUNK, 'fileId': 'file_01'}, 'unknown')
        self.reject({**CHUNK, 'title': 'doc'}, 'unknown')

    def test_file_shape_and_locator_mirror(self):
        self.accept(FILE)
        for locator in ({'kind': 'page', 'page': 2}, {'kind': 'slide', 'slide': 1}, {'kind': 'paragraph', 'index': 0},
                        {'kind': 'paragraph', 'index': 4, 'heading': 'Pricing'}, {'kind': 'cells', 'sheet': 'Sheet1', 'range': 'A1:B2'},
                        {'kind': 'image'}, {'kind': 'lines', 'start': 7, 'end': 7}):
            with self.subTest(locator=locator):
                self.accept({**FILE, 'locator': locator})
        for locator in ({'kind': 'lines', 'start': 3, 'end': 1}, {'kind': 'lines', 'start': 0, 'end': 1}, {'kind': 'lines', 'start': 1},
                        {'kind': 'page', 'page': 0}, {'kind': 'page', 'page': '1'}, {'kind': 'slide', 'slide': 1.5},
                        {'kind': 'paragraph', 'index': -1}, {'kind': 'paragraph', 'index': 0, 'heading': 3},
                        {'kind': 'cells', 'sheet': '', 'range': 'A1'}, {'kind': 'cells', 'sheet': 'S', 'range': 'x' * 65},
                        {'kind': 'image', 'extra': 1}, {'kind': 'offset', 'start': 1}, 'lines 1-3', None):
            with self.subTest(locator=locator):
                self.reject({**FILE, 'locator': locator})
        self.reject({**FILE, 'backendKind': 's3'}, 'backendKind')
        self.reject({**FILE, 'revision': '1'}, 'revision')
        self.reject({**FILE, 'revision': 'sha256:' + 'A' * 64}, 'revision')
        self.reject({**FILE, 'revision': 'sha256:' + 'a' * 63}, 'revision')
        for path in ('/etc/passwd', '../a.md', 'a/../b.md', 'a//b.md', 'a\\b.md', 'a\nb.md', './a.md', '', 'x' * 4097):
            with self.subTest(path=path):
                self.reject({**FILE, 'relativePath': path}, 'relativePath')
        self.reject({k: v for k, v in FILE.items() if k != 'locator'}, 'missing')
        self.reject({k: v for k, v in FILE.items() if k != 'revision'}, 'missing')
        self.reject({**FILE, 'scope': 'x'}, 'unknown')
        self.reject({**FILE, 'workspaceId': ' '}, 'workspaceId')

    def test_external_shape(self):
        self.accept(EXTERNAL)
        for url in ('javascript:alert(1)', 'file:///tmp/x', 'https://user:pass@example.com/a', '//example.com', 'https://example.com/a b', 'ftp://example.com/a', ''):
            with self.subTest(url=url):
                self.reject({'kind': 'external', 'url': url})
        self.reject({'kind': 'external'}, 'missing')
        self.reject({'kind': 'external', 'url': 'https://example.test', 'title': 'x'}, 'unknown')

    def test_unknown_or_malformed_kind_rejected(self):
        self.reject({'kind': 'kb', 'sourceId': 'a'}, 'Unsupported provenance kind')
        self.reject({'kind': None}, 'Unsupported provenance kind')
        self.reject({'kind': 'chunk'}, 'missing')
        self.reject('chunk', 'provenance')
        self.reject([], 'provenance')

    def test_legacy_freeform_provenance_still_accepted(self):
        for source in self.report['sources']:
            self.assertEqual(provenance_status(source), 'legacy')
        validate_report(self.report)
        self.accept({'locator': 'sources/qinglan.md'})
        self.accept({'sourceId': 'a', 'documentId': 'b', 'chunkId': 'c', 'fileId': 'd', 'scope': 'e', 'revision': 'f', 'locator': 'g'})
        self.reject({}, 'Empty provenance')
        self.reject({'secret': 'x'}, 'unknown')
        self.reject({'fileId': ''}, 'fileId')
        self.reject({'fileId': 3}, 'fileId')
        self.reject({'fileId': 'x' * 1001}, 'fileId')
        self.reject({'workspaceId': 'ws'}, 'unknown')

    def test_missing_provenance_is_valid_and_classified(self):
        report = self.with_provenance(None)
        validate_report(report)
        self.assertEqual(provenance_status(report['sources'][0]), 'missing')
        self.assertEqual(provenance_counts(report), {'resolvable': 0, 'legacy': 2, 'missing': 1})

    def test_counts_cover_every_shape(self):
        report = self.with_provenance(CHUNK, 0)
        report['sources'][1]['provenance'] = FILE
        report['sources'][2]['provenance'] = EXTERNAL
        validate_report(report)
        self.assertEqual(provenance_counts(report), {'resolvable': 3, 'legacy': 0, 'missing': 0})
        report['sources'][1]['provenance'] = {'scope': 'legacy'}
        report['sources'][2].pop('provenance')
        self.assertEqual(provenance_counts(report), {'resolvable': 1, 'legacy': 1, 'missing': 1})


class ProvenanceVerifyAndRenderTest(unittest.TestCase):
    def setUp(self):
        self.report = read_report(FIXTURE)
        self.report['sources'][0]['provenance'] = CHUNK
        self.report['sources'][1]['provenance'] = {**FILE, 'relativePath': 'PRIVATE-FIXTURE-PATH/notes.md'}
        self.report['sources'][2].pop('provenance')
        self.report['sources'][2]['display']['url'] = 'https://example.test/chenfan?tab=[S3]'
        validate_report(self.report)

    def test_verify_reports_structural_counts_without_authentication(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'input.json'
            source.write_text(json.dumps(self.report, ensure_ascii=False), encoding='utf-8')
            out = Path(temporary) / 'v1'
            generate(source, out, ['html', 'md'])
            (out / 'report.html').write_bytes((out / 'draft.html').read_bytes())
            result = verify(source, out, ['html', 'md'])
            self.assertTrue(result['passed'])
            self.assertEqual(result['provenance'], {'resolvable': 2, 'legacy': 0, 'missing': 1})
            self.assertFalse(result['evidenceAuthenticated'])
            self.assertEqual(json.loads(json.dumps(result))['provenance'], result['provenance'])
            # Legacy fixture: the historical shape is still counted, never rejected.
            self.assertEqual(verify(FIXTURE, self.legacy_output(temporary), ['html', 'md'])['provenance'], {'resolvable': 0, 'legacy': 3, 'missing': 0})

    @staticmethod
    def legacy_output(temporary):
        out = Path(temporary) / 'legacy'
        generate(FIXTURE, out, ['html', 'md'])
        (out / 'report.html').write_bytes((out / 'draft.html').read_bytes())
        return out

    def cited_ids(self):
        ids = []
        for item in self.report['summary']:
            ids.append(item['citations'])
        for section in self.report['sections']:
            for block in section['blocks']:
                if block['type'] == 'paragraph':
                    ids.append(block['citations'])
                elif block['type'] == 'bullets':
                    ids.extend(item['citations'] for item in block['items'])
                else:
                    ids.extend(cell['citations'] for row in block['rows'] for cell in row)
        return ids

    def test_html_citation_anchors_and_source_ids_for_both_layouts(self):
        for layout in ('inline', 'source-notes'):
            with self.subTest(layout=layout):
                self.report['presentation'] = {'citationLayout': layout}
                validate_report(self.report)
                html = html_document(self.report)
                anchors = re.findall(r'<a class="cite" href="#src-(S\d+)">\[(S\d+)\]</a>', html)
                self.assertEqual(len(anchors), sum(len(ids) for ids in self.cited_ids()))
                self.assertTrue(all(target == label for target, label in anchors))
                for ids in self.cited_ids():
                    if ids:
                        expected = ' '.join(f'<a class="cite" href="#src-{sid}">[{sid}]</a>' for sid in ids)
                        self.assertIn(expected, html)
                        if layout == 'source-notes':
                            self.assertIn('<p class="source-note">来源: ' + expected + '</p>', html)
                sources = re.search(r'<section class="sources">.*?</section>', html, re.S).group(0)
                for source in self.report['sources']:
                    sid = source['id']
                    self.assertIn(f'<p id="src-{sid}" data-source-id="{sid}">{escape(source_text(source), quote=True)}</p>', sources)
                targets = {target for target, _ in anchors}
                self.assertTrue(targets <= set(re.findall(r'<p id="src-(S\d+)"', sources)))
                # Only in-document navigation: publish validation requires a[href] to start with '#'.
                self.assertTrue(all(href.startswith('#') for href in re.findall(r'<a [^>]*href="([^"]*)"', html)))
                self.assertNotIn('<a href="https://example.test', html)
                self.assertIn('https://example.test/chenfan?tab=[S3]</p>', html)
                # Private provenance never reaches HTML.
                for private in ('src_01', 'chk_01', 'PRIVATE-FIXTURE-PATH', SHA, 'cloud_vfs'):
                    self.assertNotIn(private, html)

    def test_public_text_extraction_unchanged_by_anchors(self):
        for layout in ('inline', 'source-notes'):
            with self.subTest(layout=layout):
                self.report['presentation'] = {'citationLayout': layout}
                validate_report(self.report)
                parser = PublicHTML()
                parser.feed(html_document(self.report))
                self.assertEqual(normalized('\n'.join(parser.parts)), normalized(' '.join(public_texts(self.report))))
                markdown = markdown_document(self.report)
                self.assertNotIn('<a ', markdown)
                self.assertNotIn('src-S', markdown)
                self.assertIn('\\[S1\\]', markdown)


if __name__ == '__main__':
    unittest.main()
