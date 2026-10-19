"""Pure content-contract tests; actual distinct-PDF negatives run in the native lane."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from report_schema import read_report, public_texts, cell_text, statement_text
from verify_report import assert_content


class PdfContentRegression(unittest.TestCase):
    def setUp(self):
        self.source = read_report(ROOT/'tests/fixtures/pdf-multicolumn.source.json')
        self.text = '\n'.join(public_texts(self.source))

    def test_interleaved_layout_text_does_not_satisfy_complete_cells(self):
        row = self.source['sections'][0]['blocks'][0]['rows'][0]
        date = cell_text(row[1], self.source)
        description = cell_text(row[2], self.source)
        interleaved = date[:17]+'\n'+description[:18]+'\n'+date[17:]+'\n'+description[18:]
        broken = self.text.replace(date+'\n'+description, interleaved)
        with self.assertRaisesRegex(ValueError, 'PDF content differs'):
            assert_content(self.source, broken, 'PDF', ordered=False)

    def test_missing_character_changed_date_and_missing_reference_still_fail(self):
        citation_paragraph = statement_text(self.source['sections'][0]['blocks'][1], self.source)
        cases = [
            self.text.replace('字符', '符'),
            self.text.replace('2026-07-16', '2026-07-17'),
            self.text.replace(citation_paragraph, citation_paragraph.removesuffix(' [S1]')),
        ]
        for mutated in cases:
            with self.subTest(case=cases.index(mutated)):
                with self.assertRaisesRegex(ValueError, 'PDF content differs'):
                    assert_content(self.source, mutated, 'PDF', ordered=False)


if __name__ == '__main__':
    unittest.main()
