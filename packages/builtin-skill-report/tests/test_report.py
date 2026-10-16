"""Host tests cover pure stdlib logic only; Office qualification requires the sandbox."""
import copy
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from report_schema import read_report, validate_report, parse_formats
from generate_report import html_document, markdown_document, generate, preflight, table_column_widths_mm, estimated_cell_width_mm, strip_paragraph_borders
from verify_report import verify, docx_text

FIXTURE = ROOT / 'tests/fixtures/comparison.source.json'


CONTENT_TYPES = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
PACKAGE_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
DOCUMENT_XML = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>test</w:t></w:r></w:p></w:body></w:document>'


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.report = read_report(FIXTURE)

    def reject(self, mutate, message=None):
        report = copy.deepcopy(self.report)
        mutate(report)
        with self.assertRaises(ValueError):
            validate_report(report)

    def test_valid_source_and_formats(self):
        self.assertEqual(self.report['template'], 'comparison')
        self.assertEqual(parse_formats('html,md,pdf'), ['html', 'md', 'pdf'])
        for formats in ('md', 'html,pptx', 'html,html', 'html, md'):
            with self.assertRaises(ValueError):
                parse_formats(formats)

    def test_schema_unknown_version_keys_and_duplicate_identity(self):
        self.reject(lambda r: r.update(schemaVersion=True))
        self.reject(lambda r: r.update(schemaVersion=2))
        self.reject(lambda r: r.update(untrusted='x'))
        self.reject(lambda r: r['sources'].append(copy.deepcopy(r['sources'][0])))
        self.reject(lambda r: r['sections'].append(copy.deepcopy(r['sections'][0])))
        self.reject(lambda r: r['sources'][0]['provenance'].update(secret='x'))

    def test_facts_need_real_report_reference_and_table_dimensions(self):
        self.reject(lambda r: r['summary'][1].update(citations=[]))
        self.reject(lambda r: r['summary'][1].update(citations=['S99']))
        self.reject(lambda r: r['summary'][1].update(citations=['S1','S1']))
        self.reject(lambda r: r['sections'][0]['blocks'][0]['rows'][0].pop())
        self.reject(lambda r: r['sections'][0]['blocks'][0]['rows'][0][0].update(citations=[]))
        self.reject(lambda r: r['sections'][0]['blocks'][0]['rows'][0][0].update(status='guessed'))

    def test_runtime_markers_and_unsafe_urls_rejected(self):
        for marker in ('[c1]', '[citation:c1]', '【citation:c1】', '[citation: c1,c2 ]', '[\u200bcitation:c1\u200b]', '[[cite:c1]]', 'citex'):
            self.reject(lambda r: r['summary'][0].update(text=marker))
            self.reject(lambda r: r['sources'][0]['display'].update(locator=marker))
        for url in ('javascript:alert(1)', 'file:///tmp/x', 'https://user:pass@example.com/a', '//example.com', 'https://example.com/a b'):
            self.reject(lambda r: r['sources'][0]['display'].update(url=url))

    def test_public_outputs_escape_text_and_exclude_private_provenance(self):
        self.report['summary'][0]['text'] = '<script>alert("x")</script> & [text] | raw'
        validate_report(self.report)
        rendered = html_document(self.report)
        self.assertIn('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;', rendered)
        self.assertNotIn('<script>alert(', rendered)
        markdown = markdown_document(self.report)
        self.assertIn('\\<script\\>', markdown)
        for source in self.report['sources']:
            for value in (source['provenance']['fileId'], source['provenance']['locator']):
                self.assertNotIn(value, rendered)
                self.assertNotIn(value, markdown)
        self.assertIn('来源冲突', rendered)
        self.assertIn('资料未说明', rendered)
        self.assertIn('分析:', rendered)
        self.assertIn('建议:', rendered)

    def test_html_md_generation_frozen_input_and_tamper_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'fresh'
            generate(FIXTURE, out, ['html','md'])
            # Pure test: render source HTML only; do not claim the provisioned
            # bundler, browser, fonts or sandbox ran.
            (out/'report.html').write_bytes((out/'draft.html').read_bytes())
            result = verify(FIXTURE, out, ['html','md'])
            self.assertTrue(result['passed'])
            self.assertFalse(result['evidenceAuthenticated'])
            self.assertEqual(result['visualReview'], 'not_run')
            self.assertFalse((out/'report.docx').exists())
            self.assertFalse((out/'report.pdf').exists())
            self.assertEqual(read_report(out/'report.source.json'), self.report)
            (out/'report.md').write_text('tampered', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Markdown differs'):
                verify(FIXTURE, out, ['html','md'])

    def test_extra_visible_html_text_outside_main_and_private_sentinel_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'fresh'
            generate(FIXTURE, out, ['html','md'])
            original = (out/'draft.html').read_text(encoding='utf-8')
            for extra in ('<footer>PRIVATE-FIXTURE-QINGLAN</footer>', '<p>价格是 0 元</p>', '<p>123456789</p>'):
                (out/'report.html').write_text(original.replace('</body>', extra+'</body>'), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'full public text differs'):
                    verify(FIXTURE, out, ['html','md'])

    def test_executable_html_cannot_pass_with_matching_visible_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'fresh'
            generate(FIXTURE, out, ['html','md'])
            original = (out/'draft.html').read_text(encoding='utf-8')
            for extra in ('<script>console.log("injected")</script>', '<img onerror="alert(1)">', '<iframe></iframe>'):
                (out/'report.html').write_text(original.replace('</body>', extra+'</body>'), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Executable report HTML'):
                    verify(FIXTURE, out, ['html','md'])

    def test_fresh_directory_and_unrequested_output_rejection(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'fresh'
            generate(FIXTURE, out, ['html','md'])
            with self.assertRaises(FileExistsError):
                generate(FIXTURE, out, ['html','md'])
            (out/'report.html').write_bytes((out/'draft.html').read_bytes())
            (out/'report.pdf').write_bytes(b'old')
            with self.assertRaisesRegex(ValueError, 'Unrequested'):
                verify(FIXTURE, out, ['html','md'])

    def test_no_duplicate_json_keys_or_oversized_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'input.json'
            path.write_text('{"schemaVersion":1,"schemaVersion":1}')
            with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
                read_report(path)
            path.write_bytes(b'x' * (2*1024*1024+1))
            with self.assertRaisesRegex(ValueError, '2 MiB'):
                read_report(path)

    def test_docx_extra_header_text_rejected_without_office_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'test.docx'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('[Content_Types].xml', CONTENT_TYPES)
                archive.writestr('_rels/.rels', PACKAGE_RELS)
                archive.writestr('word/document.xml', DOCUMENT_XML)
                archive.writestr('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>PRIVATE-SENTINEL</w:t></w:r></w:p></w:hdr>')
            with self.assertRaisesRegex(ValueError, 'outside the report DOCX body'):
                docx_text(path)

    def test_template_heading_and_direct_title_borders_removed_without_changing_text_style(self):
        namespace = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        for tag in ('style', 'p'):
            element = ET.fromstring(f'<w:{tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:color="4F81BD" w:themeColor="accent1"/></w:pBdr></w:pPr><w:rPr><w:color w:val="000000"/><w:sz w:val="44"/></w:rPr></w:{tag}>')
            strip_paragraph_borders(element)
            self.assertIsNone(element.find(namespace+'pPr').find(namespace+'pBdr'))
            self.assertIsNotNone(element.find(namespace+'pPr').find(namespace+'keepNext'))
            self.assertEqual(element.find(namespace+'rPr').find(namespace+'color').get(namespace+'val'), '000000')
            self.assertEqual(element.find(namespace+'rPr').find(namespace+'sz').get(namespace+'val'), '44')
            strip_paragraph_borders(element)  # Safe when already clean.

    def test_docx_column_widths_protect_full_short_cells_and_wrap_long_prose(self):
        block = self.report['sections'][0]['blocks'][0]
        widths = table_column_widths_mm(block, self.report)
        self.assertAlmostEqual(sum(widths), 170.0)
        # The original raw-text-only weights underestimated this cell and its
        # source label, causing PDF extraction to interleave wrapped columns.
        self.assertGreaterEqual(widths[1], estimated_cell_width_mm('Markdown、PDF [S2]'))
        self.assertGreaterEqual(widths[1], estimated_cell_width_mm('HTML 阅读、XLSX [S3]'))
        self.assertGreaterEqual(widths[2], estimated_cell_width_mm('未提供 (资料未说明)'))
        self.assertGreaterEqual(widths[0], estimated_cell_width_mm('晨帆资料台 [S3]'))
        self.assertLess(widths[3], estimated_cell_width_mm('10 人与 20 人两种记录；版本与口径未解释 (来源冲突) [S1] [S3]'))
        self.assertGreater(estimated_cell_width_mm('资料'), estimated_cell_width_mm('AB'))

    def test_docx_too_many_dense_columns_fail_without_shrinking_text(self):
        block = {'columns': ['维度'] * 10, 'rows': [[{'text': '比较内容', 'status': 'value', 'citations': ['S1']}] * 10]}
        with self.assertRaisesRegex(ValueError, 'readable portrait DOCX width'):
            table_column_widths_mm(block, self.report)

    def test_docx_missing_package_parts_cannot_pass_as_a_document(self):
        parts = {'[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': PACKAGE_RELS, 'word/document.xml': DOCUMENT_XML}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'test.docx'
            for missing in parts:
                with zipfile.ZipFile(path, 'w') as archive:
                    for name, value in parts.items():
                        if name != missing:
                            archive.writestr(name, value)
                with self.assertRaisesRegex(ValueError, 'Missing required DOCX package parts'):
                    docx_text(path)

    def test_docx_main_type_relationship_and_duplicate_members_are_checked(self):
        cases = [
            (CONTENT_TYPES.replace('wordprocessingml.document.main+xml', 'spreadsheetml.sheet.main+xml'), PACKAGE_RELS, 'main document content type'),
            (CONTENT_TYPES, PACKAGE_RELS.replace('Target="word/document.xml"', 'Target="word/wrong.xml"'), 'officeDocument relationship'),
            (CONTENT_TYPES, PACKAGE_RELS.replace('Target="word/document.xml"', 'Target="word/document.xml" TargetMode="External"'), 'officeDocument relationship'),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'test.docx'
            for content_types, relationships, message in cases:
                with zipfile.ZipFile(path, 'w') as archive:
                    archive.writestr('[Content_Types].xml', content_types)
                    archive.writestr('_rels/.rels', relationships)
                    archive.writestr('word/document.xml', DOCUMENT_XML)
                with self.assertRaisesRegex(ValueError, message):
                    docx_text(path)
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                with zipfile.ZipFile(path, 'w') as archive:
                    archive.writestr('[Content_Types].xml', CONTENT_TYPES)
                    archive.writestr('_rels/.rels', PACKAGE_RELS)
                    archive.writestr('word/document.xml', DOCUMENT_XML)
                    archive.writestr('word/document.xml', DOCUMENT_XML)
            with self.assertRaisesRegex(ValueError, 'Duplicate DOCX archive member'):
                docx_text(path)

    def test_fallback_family_does_not_satisfy_explicit_document_font(self):
        # No host font or python-docx qualification: test only exact matching.
        with patch.dict(sys.modules, {'docx': object()}), patch('generate_report.shutil.which', return_value='/provisioned/fc-match'), patch('generate_report.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout='Noto Sans CJK JP')):
            with self.assertRaisesRegex(RuntimeError, 'Required font is unavailable: Noto Sans'):
                preflight(['html','docx'])
        with patch.dict(sys.modules, {'docx': object()}), patch('generate_report.shutil.which', return_value='/provisioned/fc-match'), patch('generate_report.subprocess.run', side_effect=[subprocess.CompletedProcess([], 0, stdout='Noto Sans,Alias'), subprocess.CompletedProcess([], 0, stdout='Noto Sans CJK SC')]):
            preflight(['html','docx'])

    def test_requested_dependency_failure_leaves_no_success_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)/'fresh'
            with patch('generate_report.preflight', side_effect=RuntimeError('missing dependency')):
                with self.assertRaisesRegex(RuntimeError, 'missing dependency'):
                    generate(FIXTURE, out, ['html','pdf'])
            self.assertFalse(out.exists())

    def test_private_source_mismatch_blocks_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)/'fresh'
            generate(FIXTURE, out, ['html','md'])
            (out/'report.html').write_bytes((out/'draft.html').read_bytes())
            changed = copy.deepcopy(self.report)
            changed['title'] = 'Different valid source version'
            (out/'report.source.json').write_text(json.dumps(changed, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Private source does not match'):
                verify(FIXTURE, out, ['html','md'])

    def test_pdf_timeout_leaves_no_deliverable_or_temporary_docx(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)/'fresh'
            temp_docx = []
            def fake_docx(report, path):
                temp_docx.append(Path(path))
                Path(path).write_bytes(b'test-docx')
            with patch('generate_report.preflight'), patch('generate_report.write_docx', side_effect=fake_docx), patch('generate_report.subprocess.run', side_effect=subprocess.TimeoutExpired('soffice', 90)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    generate(FIXTURE, out, ['html','pdf'])
            self.assertFalse((out/'report.pdf').exists())
            self.assertFalse((out/'report.docx').exists())
            self.assertEqual(len(temp_docx), 1)
            self.assertFalse(temp_docx[0].exists())

    def test_pdf_nonzero_exit_rejects_even_a_leftover_converted_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)/'fresh'
            converted_paths = []
            def failed_conversion(command, **kwargs):
                converted = Path(command[command.index('--outdir') + 1])/'report.pdf'
                converted.write_bytes(b'%PDF-1.4 failed intermediate')
                converted_paths.append(converted)
                return subprocess.CompletedProcess(command, 1)
            with patch('generate_report.preflight'), patch('generate_report.write_docx', side_effect=lambda r,p: Path(p).write_bytes(b'test-docx')), patch('generate_report.subprocess.run', side_effect=failed_conversion):
                with self.assertRaisesRegex(RuntimeError, 'conversion failed'):
                    generate(FIXTURE, out, ['html','pdf'])
            self.assertFalse((out/'report.pdf').exists())
            self.assertFalse((out/'report.docx').exists())
            self.assertEqual(len(converted_paths), 1)
            self.assertFalse(converted_paths[0].exists())

    def test_pdf_failure_does_not_pick_stale_file_or_emit_extra_docx(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)/'fresh'
            with patch('generate_report.preflight'), patch('generate_report.write_docx', side_effect=lambda r,p: Path(p).write_bytes(b'test-docx')), patch('generate_report.subprocess.run', return_value=subprocess.CompletedProcess([], 0)):
                with self.assertRaisesRegex(RuntimeError, 'conversion failed'):
                    generate(FIXTURE, out, ['html','pdf'])
            self.assertFalse((out/'report.pdf').exists())
            self.assertFalse((out/'report.docx').exists())


if __name__ == '__main__':
    unittest.main()
