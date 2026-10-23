"""Repeated table headings on actual PDF pages (generator retry and verifier gate)."""
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from generate_report import generate
from report_schema import read_report, cell_parts, table_header_gaps
from verify_report import verify

FIXTURE = ROOT / 'tests/fixtures/long-table.source.json'


def heading_line(block):
    return ' '.join(block['columns'])


def row_lines(block, report, rows):
    # Poppler raw mode emits each cell's body and then its source note.
    return '\n'.join('\n'.join(part for parts in (cell_parts(cell, report) for cell in row) for part in parts if part) for row in rows)


class TableHeadingGaps(unittest.TestCase):
    def setUp(self):
        self.report = read_report(FIXTURE)
        self.block = self.report['sections'][0]['blocks'][0]

    def page(self, rows, heading=True):
        return ('目录\n' if heading else '') + (heading_line(self.block) + '\n' if heading else '') + row_lines(self.block, self.report, rows)

    def test_heading_before_rows_on_every_page_passes(self):
        rows = self.block['rows']
        pages = [self.page(rows[:10]), self.page(rows[10:20]), self.page(rows[20:])]
        self.assertEqual(table_header_gaps(self.report, pages), [])

    def test_continuation_rows_without_actual_heading_are_reported(self):
        rows = self.block['rows']
        # Shape observed from LibreOffice: heading stranded on page 1, blank repeats after it.
        pages = [self.page([]), self.page(rows[:10], heading=False), self.page(rows[10:], heading=False)]
        gaps = table_header_gaps(self.report, pages)
        self.assertEqual([gap['page'] for gap in gaps], [2, 3])
        self.assertEqual({gap['table'] for gap in gaps}, {(0, 0)})
        self.assertEqual(gaps[0]['section'], self.report['sections'][0]['heading'])

    def test_a_later_tables_heading_does_not_cover_rows_above_it(self):
        report = copy.deepcopy(self.report)
        second = copy.deepcopy(self.block)
        for index, row in enumerate(second['rows']):
            row[0]['text'] = f'NEXT{index:03d}'
        report['sections'][1]['blocks'].append(second)
        first_rows, second_rows = self.block['rows'], second['rows']
        # Same column names: the second table's heading follows the first table's unheaded tail.
        page_two = row_lines(self.block, report, first_rows[20:]) + '\n' + heading_line(second) + '\n' + row_lines(second, report, second_rows[:5])
        pages = [self.page(first_rows[:20]), page_two, heading_line(second) + '\n' + row_lines(second, report, second_rows[5:])]
        self.assertEqual([(gap['page'], gap['table']) for gap in table_header_gaps(report, pages)], [(2, (0, 0))])

    def test_whitespace_and_wrapping_do_not_hide_rows(self):
        rows = self.block['rows'][:3]
        wrapped = self.page(rows).replace('：', '：\n').replace(' ', '\n')
        self.assertEqual(table_header_gaps(self.report, [wrapped]), [])
        self.assertEqual(len(table_header_gaps(self.report, [row_lines(self.block, self.report, rows).replace(' ', '\n')])), 1)


class GeneratorFreshPageRetry(unittest.TestCase):
    def run_generate(self, page_texts, formats=('html', 'pdf')):
        report = read_report(FIXTURE)
        block = report['sections'][0]['blocks'][0]
        good = ['目录\n' + heading_line(block) + '\n' + row_lines(block, report, block['rows'])]
        bad = ['目录\n' + heading_line(block), row_lines(block, report, block['rows'])]
        texts = iter([{'good': good, 'bad': bad}[name] for name in page_texts])
        docx_calls = []
        conversions = []

        def fake_docx(report, path, fresh_page_tables=frozenset()):
            docx_calls.append(fresh_page_tables)
            Path(path).write_bytes(b'test-docx')

        def fake_run(command, **kwargs):
            if command[0] == 'soffice':
                converted = Path(command[command.index('--outdir') + 1]) / 'report.pdf'
                converted.write_bytes(b'%PDF-1.4 converted')
                conversions.append(converted)
                return subprocess.CompletedProcess(command, 0)
            self.assertEqual(command[:2], ['pdftotext', '-raw'])
            return subprocess.CompletedProcess(command, 0, stdout='\f'.join(next(texts)) + '\f')

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        out = Path(temporary.name) / 'fresh'
        # Converters are stubbed above; the fixture's contents only make generate
        # look up pdftohtml, which host test runners need not have.
        with patch('generate_report.preflight'), patch('generate_report.shutil.which', return_value='/usr/bin/pdftohtml'), patch('generate_report.write_docx', side_effect=fake_docx), patch('generate_report.subprocess.run', side_effect=fake_run):
            try:
                generate(FIXTURE, out, list(formats))
            finally:
                self.docx_calls, self.conversions, self.out = docx_calls, conversions, out

    def test_no_retry_when_headings_already_repeat(self):
        self.run_generate(['good'])
        self.assertEqual(self.docx_calls, [frozenset()])
        self.assertEqual(len(self.conversions), 1)
        self.assertTrue((self.out / 'report.pdf').is_file())

    def test_stranded_heading_table_is_regenerated_on_a_fresh_page_once(self):
        self.run_generate(['bad', 'good'], formats=('html', 'docx', 'pdf'))
        self.assertEqual(self.docx_calls, [frozenset(), frozenset({(0, 0)})])
        self.assertEqual(len(self.conversions), 2)
        # The delivered Word file is the same retried document the PDF came from.
        self.assertEqual((self.out / 'report.docx').read_bytes(), b'test-docx')
        self.assertTrue((self.out / 'report.pdf').is_file())

    def test_persistent_missing_headings_block_the_pdf(self):
        with self.assertRaisesRegex(RuntimeError, 'did not repeat table headings on PDF pages 2'):
            self.run_generate(['bad', 'bad'])
        self.assertEqual(len(self.conversions), 2)
        self.assertFalse((self.out / 'report.pdf').exists())


class VerifierHeadingGate(unittest.TestCase):
    def test_pdf_with_unheaded_continuation_rows_fails_verification(self):
        report = read_report(FIXTURE)
        block = report['sections'][0]['blocks'][0]
        raw = '\f'.join(['目录\n' + heading_line(block), row_lines(block, report, block['rows'])]) + '\f'

        def fake_run(command, **kwargs):
            if command[:2] == ['pdftotext', '-raw']:
                Path(command[3]).write_text(raw, encoding='utf-8')
                return subprocess.CompletedProcess(command, 0)
            raise AssertionError(f'unexpected command {command}')

        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'attempt'
            generate(FIXTURE, out, ['html'])
            (out / 'report.pdf').write_bytes(b'%PDF-1.4 test')
            with patch('verify_report.subprocess.run', side_effect=fake_run):
                with self.assertRaisesRegex(ValueError, 'PDF table headings are missing on actual pages: 跨页核验记录 p2'):
                    verify(FIXTURE, out, ['pdf'])


if __name__ == '__main__':
    unittest.main()
