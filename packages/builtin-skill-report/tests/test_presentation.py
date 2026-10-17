"""Strict presentation source contract and compatible semantic reading order."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from generate_report import generate
from verify_report import verify
from report_schema import (read_report, validate_report, effective_presentation,
    statement_parts, statement_text, cell_parts, cell_text, contents_entries,
    public_texts, labels, source_text)


class PresentationTest(unittest.TestCase):
    def setUp(self):
        self.report = read_report(ROOT / 'tests/fixtures/comparison.source.json')

    def test_old_source_defaults_do_not_mutate_input(self):
        original = copy.deepcopy(self.report)
        self.assertEqual(effective_presentation(self.report), {
            'mobileDensity': 'standard', 'tableOfContents': False,
            'pageNumbers': False, 'citationLayout': 'inline'})
        self.assertEqual(self.report, original)
        for statement in self.report['summary']:
            self.assertEqual(statement_parts(statement, self.report), (statement_text(statement, self.report), None))
        for row in self.report['sections'][0]['blocks'][0]['rows']:
            for cell in row:
                self.assertEqual(cell_parts(cell, self.report), (cell_text(cell, self.report), None))
        self.assertEqual(contents_entries(self.report), [])

    def test_empty_and_explicit_defaults_preserve_old_public_text(self):
        expected = list(public_texts(self.report))
        for configuration in ({}, effective_presentation(self.report)):
            self.report['presentation'] = configuration
            validate_report(self.report)
            self.assertEqual(list(public_texts(self.report)), expected)
            self.assertEqual(self.report['presentation'], configuration)

    def test_strict_config_rejects_unknown_freeform_and_wrong_types(self):
        invalid = [None, [], 'compact', {'rawCSS': 'body{}'}, {'font': 'Inter'},
            {'mobileDensity': 'dense'}, {'mobileDensity': None}, {'mobileDensity': []},
            {'citationLayout': 'footnotes'}, {'citationLayout': 1},
            {'tableOfContents': 1}, {'tableOfContents': 'true'}, {'tableOfContents': None},
            {'pageNumbers': 0}, {'pageNumbers': 'false'}, {'pageNumbers': None}]
        for configuration in invalid:
            with self.subTest(configuration=configuration):
                self.report['presentation'] = configuration
                with self.assertRaises(ValueError):
                    validate_report(self.report)

    def test_each_optional_setting_resolves_independently_and_frozen_roundtrip(self):
        for key, value in [('mobileDensity', 'compact'), ('tableOfContents', True),
                           ('pageNumbers', True), ('citationLayout', 'source-notes')]:
            with self.subTest(key=key):
                self.report['presentation'] = {key: value}
                validate_report(self.report)
                self.assertEqual(effective_presentation(self.report)[key], value)
                with tempfile.TemporaryDirectory() as temporary:
                    path = Path(temporary) / 'report.source.json'
                    path.write_text(json.dumps(self.report, ensure_ascii=False), encoding='utf-8')
                    recovered = read_report(path)
                    recovered['summary'][0]['text'] += ' Revision.'
                    self.assertEqual(recovered['presentation'], {key: value})
                    self.assertEqual(set(recovered['presentation']), {key})
        resolved = effective_presentation(self.report)
        resolved['mobileDensity'] = 'compact'
        self.assertNotIn('mobileDensity', self.report['presentation'])

    def test_source_notes_keep_localization_order_status_and_no_empty_notes(self):
        self.report['presentation'] = {'citationLayout': 'source-notes'}
        for language, label in [('zh-CN', '来源'), ('en-US', 'Sources')]:
            self.report['language'] = language
            for item in self.report['summary']:
                body, note = statement_parts(item, self.report)
                self.assertEqual(body, statement_text({**item, 'citations': []}, self.report))
                self.assertEqual(note, label + ':' + ''.join(f' [{sid}]' for sid in item['citations']) if item['citations'] else None)
            unknown = {'text': 'Not provided 2026-10-17', 'status': 'unknown', 'citations': []}
            self.assertEqual(cell_parts(unknown, self.report), (cell_text(unknown, self.report), None))
            cited = {'text': '10 versus 20', 'status': 'conflict', 'citations': ['S2', 'S1']}
            body, note = cell_parts(cited, self.report)
            self.assertIn(labels(self.report)['conflict'], body)
            self.assertIn('10 versus 20', body)
            self.assertEqual(note, label + ': [S2] [S1]')

    def test_presentation_private_copy_tampering_blocks_verification(self):
        self.report['presentation'] = {'mobileDensity': 'compact'}
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'input.json'
            source.write_text(json.dumps(self.report, ensure_ascii=False), encoding='utf-8')
            output = Path(temporary) / 'v1'
            generate(source, output, ['html', 'md'])
            (output / 'report.html').write_bytes((output / 'draft.html').read_bytes())
            self.assertTrue(verify(source, output, ['html', 'md'])['passed'])
            changed = read_report(output / 'report.source.json')
            changed['presentation']['mobileDensity'] = 'standard'
            (output / 'report.source.json').write_text(json.dumps(changed, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Private source does not match'):
                verify(source, output, ['html', 'md'])

    def test_private_roundtrip_revision_preserves_layout_and_original_outputs(self):
        self.report['presentation'] = {'mobileDensity': 'compact', 'tableOfContents': True,
            'pageNumbers': True, 'citationLayout': 'source-notes'}
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'input.json'
            source.write_text(json.dumps(self.report, ensure_ascii=False), encoding='utf-8')
            original = Path(temporary) / 'v1'
            generate(source, original, ['html', 'md'])
            (original / 'report.html').write_bytes((original / 'draft.html').read_bytes())
            self.assertTrue(verify(source, original, ['html', 'md'])['passed'])
            frozen_files = {path.name: path.read_bytes() for path in original.iterdir()}
            # This exercises only private source persistence, not host ACL/CAS.
            recovered = read_report(original / 'report.source.json')
            recovered['summary'][0]['text'] += ' EDITED-2026-10-17'
            revised_source = Path(temporary) / 'revision.json'
            revised_source.write_text(json.dumps(recovered, ensure_ascii=False), encoding='utf-8')
            revised = Path(temporary) / 'v2'
            generate(revised_source, revised, ['html', 'md'])
            (revised / 'report.html').write_bytes((revised / 'draft.html').read_bytes())
            self.assertTrue(verify(revised_source, revised, ['html', 'md'])['passed'])
            self.assertEqual(read_report(revised / 'report.source.json')['presentation'], self.report['presentation'])
            self.assertEqual({path.name: path.read_bytes() for path in original.iterdir()}, frozen_files)
            self.assertIn('EDITED-2026-10-17', (revised / 'draft.html').read_text())
            self.assertIn('EDITED', (revised / 'report.md').read_text())
            self.assertIn('来源:', (revised / 'draft.html').read_text())
            self.assertIn('目录', (revised / 'report.md').read_text())

    def test_toc_uses_actual_sections_after_complete_summary(self):
        self.report['presentation'] = {'tableOfContents': True, 'citationLayout': 'source-notes'}
        texts = list(public_texts(self.report))
        prefix = [self.report['title'], labels(self.report)['summary']]
        for item in self.report['summary']:
            prefix.extend(part for part in statement_parts(item, self.report) if part is not None)
        expected_entries = [(section['id'], section['heading']) for section in self.report['sections']]
        self.assertEqual(contents_entries(self.report), expected_entries)
        prefix.extend([labels(self.report)['contents']] + [heading for _, heading in expected_entries])
        self.assertEqual(texts[:len(prefix)], prefix)
        self.assertEqual(texts[len(prefix)], self.report['sections'][0]['heading'])
        self.assertEqual(texts[-len(self.report['sources'])-1:], [labels(self.report)['sources']] + [source_text(s) for s in self.report['sources']])
        for section in self.report['sections']:
            self.assertEqual(texts.count(section['heading']), 2)


if __name__ == '__main__':
    unittest.main()
