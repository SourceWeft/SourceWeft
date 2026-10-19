"""Presentation safety regressions; rendered layout is qualified independently."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from generate_report import page_number_footer_xml
from test_report import CONTENT_TYPES, PACKAGE_RELS
from report_schema import public_texts
from verify_report import docx_text, assert_content, pdf_body_with_page_numbers, assert_pdf_navigation, assert_docx_navigation


class TypographyTests(unittest.TestCase):
    def setUp(self):
        self.report = json.loads((Path(__file__).parent / 'fixtures/comparison.source.json').read_text())
        self.report['presentation'] = {'pageNumbers': True, 'tableOfContents': False, 'citationLayout': 'source-notes'}

    def make_document(self, directory):
        # Unit qualification is stdlib-only; actual python-docx bytes are exercised
        # by the provisioned-image Office qualification, never by host dependencies.
        path = Path(directory) / 'report.docx'
        w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        r = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
        ET.register_namespace('w', w[1:-1])
        root = ET.Element(w + 'document')
        body = ET.SubElement(root, w + 'body')
        for value in public_texts(self.report):
            paragraph = ET.SubElement(body, w + 'p')
            run = ET.SubElement(paragraph, w + 'r')
            ET.SubElement(run, w + 't').text = value
        section = ET.SubElement(body, w + 'sectPr')
        ET.SubElement(section, w + 'footerReference', {w + 'type': 'default', r + 'id': 'rId9'})
        types = CONTENT_TYPES.replace('</Types>', '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>')
        rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, value in {'[Content_Types].xml': types, '_rels/.rels': PACKAGE_RELS, 'word/document.xml': ET.tostring(root), 'word/footer1.xml': page_number_footer_xml(), 'word/_rels/document.xml.rels': rels}.items():
                archive.writestr(name, value)
        return path

    def alter(self, path, modify):
        with zipfile.ZipFile(path) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        modify(parts)
        with zipfile.ZipFile(path, 'w') as archive:
            for name, value in parts.items():
                archive.writestr(name, value)

    def test_controlled_footer_preserves_exact_public_body(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.make_document(directory)
            assert_content(self.report, docx_text(path, self.report), 'DOCX')

    def test_footer_unexpected_text_fields_objects_and_parts_are_rejected(self):
        mutations = [
            lambda parts: parts.__setitem__('word/_rels/document.xml.rels', parts['word/_rels/document.xml.rels'].replace(b'</Relationships>', b'<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/other" TargetMode="External"/></Relationships>')),
            lambda parts: parts.__setitem__('word/_rels/document.xml.rels', parts['word/_rels/document.xml.rels'].replace(b'Id="rId9"', b'Id=""')),
            lambda parts: parts.__setitem__('word/_rels/document.xml.rels', parts['word/_rels/document.xml.rels'].replace(b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"', b'Type="https://example.invalid/footer"')),
            lambda parts: parts.__setitem__('word/footer1.xml', parts['word/footer1.xml'].replace(b'Page ', b'PRIVATE ')),
            lambda parts: parts.__setitem__('word/footer1.xml', parts['word/footer1.xml'].replace(b'PAGE', b'INCLUDETEXT')),
            lambda parts: parts.__setitem__('word/footer1.xml', parts['word/footer1.xml'].replace(b'</w:p>', b'<w:r><w:drawing/></w:r></w:p>')),
            lambda parts: parts.__setitem__('word/footer2.xml', page_number_footer_xml().encode()),
            lambda parts: parts.__setitem__('word/_rels/footer1.xml.rels', b'<Relationships/>'),
            lambda parts: parts.__setitem__('word/_rels/document.xml.rels', parts['word/_rels/document.xml.rels'].replace(b'Target="footer1.xml"', b'Target="https://example.invalid/private" TargetMode="External"')),
            lambda parts: parts.__setitem__('word/_rels/document.xml.rels', parts['word/_rels/document.xml.rels'].replace(b'Target="footer1.xml"', b'Target="footer2.xml"')),
            lambda parts: parts.__setitem__('word/document.xml', parts['word/document.xml'].replace(b'w:type="default"', b'w:type="first"')),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                path = self.make_document(directory)
                self.alter(path, mutation)
                with self.assertRaises(ValueError):
                    docx_text(path, self.report)

    def test_footer_disabled_and_dangling_or_missing_numbered_footer_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.make_document(directory)
            plain = copy.deepcopy(self.report)
            plain['presentation']['pageNumbers'] = False
            with self.assertRaisesRegex(ValueError, 'outside the report DOCX body'):
                docx_text(path, plain)
            self.alter(path, lambda parts: parts.pop('word/footer1.xml'))
            with self.assertRaises(ValueError):
                docx_text(path, self.report)

    def bbox(self, footer='Page 1 / 1', y=790):
        words = ''.join(f'<word xMin="270" xMax="320" yMin="{y}" yMax="804">{word}</word>' for word in footer.split())
        return f'<html xmlns="http://www.w3.org/1999/xhtml"><body><doc><page width="595.3" height="841.89">{words}</page></doc></body></html>'.encode()

    def navigation_xml(self, headings, link_fragments=None, target_sizes=None, gap=False):
        root = ET.Element('pdf2xml')
        first = ET.SubElement(root, 'page', {'number': '1'})
        ET.SubElement(first, 'fontspec', {'id': 'body', 'size': '11'})
        ET.SubElement(first, 'fontspec', {'id': 'heading', 'size': '15'})
        for index, heading in enumerate(headings, 2):
            fragments = link_fragments[index-2] if link_fragments else [heading]
            for text in fragments:
                node = ET.SubElement(first, 'text', {'font': 'body'})
                ET.SubElement(node, 'a', {'href': f'report.html#{index}'}).text = text
            page = ET.SubElement(root, 'page', {'number': str(index)})
            for line, begin in enumerate(range(0, len(heading), 40)):
                ET.SubElement(page, 'text', {'font': 'body' if target_sizes else 'heading', 'left': '57', 'top': str(100+line*(300 if gap else 20)), 'width': '440', 'height': '20'}).text = heading[begin:begin+40]
        return root

    def test_docx_navigation_rejects_inert_styles_and_misdirected_bookmarks(self):
        report = copy.deepcopy(self.report)
        report['presentation']['tableOfContents'] = True
        w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        root = ET.Element(w+'document')
        body = ET.SubElement(root,w+'body')
        styles = ET.Element(w+'styles')
        for name in ('Hyperlink','FollowedHyperlink'):
            ET.SubElement(styles,w+'style',{w+'styleId':name,w+'type':'character'})
        for index, section in enumerate(report['sections'],1):
            paragraph=ET.SubElement(body,w+'p')
            link=ET.SubElement(paragraph,w+'hyperlink',{w+'anchor':f'sw_section_{index}',w+'history':'1'})
            run=ET.SubElement(link,w+'r')
            ET.SubElement(ET.SubElement(run,w+'rPr'),w+'rStyle',{w+'val':'Hyperlink'})
            ET.SubElement(run,w+'t').text=section['heading']
            heading=ET.SubElement(body,w+'p')
            ET.SubElement(ET.SubElement(heading,w+'pPr'),w+'pStyle',{w+'val':'Heading1'})
            ET.SubElement(heading,w+'bookmarkStart',{w+'id':str(index),w+'name':f'sw_section_{index}'})
            ET.SubElement(ET.SubElement(heading,w+'r'),w+'t').text=section['heading']
            ET.SubElement(heading,w+'bookmarkEnd',{w+'id':str(index)})
        assert_docx_navigation(report,root,styles)
        for fault in ('inert-style','wrong-target','body-prose-target'):
            document=copy.deepcopy(root); definitions=copy.deepcopy(styles)
            if fault=='inert-style': definitions.remove(list(definitions)[0])
            elif fault=='wrong-target': next(document.iter(w+'hyperlink')).set(w+'anchor','elsewhere')
            else:
                for style in document.iter(w+'pStyle'):style.set(w+'val','Normal')
            with self.subTest(fault=fault),self.assertRaisesRegex(ValueError,'DOCX contents navigation'):
                assert_docx_navigation(report,document,definitions)

    def test_pdf_navigation_accepts_wrapped_legal_heading_and_duplicate_labels(self):
        for headings, fragments in [(['研究'*100], [['研究'*50, '研究'*50]]), (['Shared heading', 'Shared heading'], None)]:
            report = copy.deepcopy(self.report)
            report['presentation']['tableOfContents'] = True
            report['sections'] = [{'id': f'section-{index}', 'heading': text} for index,text in enumerate(headings)]
            checked = assert_pdf_navigation(report, ET.tostring(self.navigation_xml(headings, fragments)), 'report.pdf')
            self.assertEqual([item['heading'] for item in checked], headings)
            self.assertEqual([item['targetPage'] for item in checked], list(range(2, len(headings)+2)))

    def test_pdf_navigation_rejects_missing_external_swapped_and_prose_targets(self):
        report = copy.deepcopy(self.report)
        report['presentation']['tableOfContents'] = True
        headings = ['First heading', 'Second heading']
        report['sections'] = [{'id': f'section-{index}', 'heading': text} for index,text in enumerate(headings)]
        for fault in ('missing', 'external', 'swapped', 'body-prose', 'extra'):
            root = self.navigation_xml(headings, target_sizes=fault=='body-prose')
            anchors = list(root.iter('a'))
            if fault=='missing':
                for text in root.find('page').findall('text'): root.find('page').remove(text)
            elif fault=='external': anchors[0].set('href', 'https://example.invalid/report.html#2')
            elif fault=='swapped': anchors[0].set('href', 'report.html#3')
            elif fault=='extra': ET.SubElement(root.find('page'), 'a', {'href':'report.html#2'}).text='Extra'
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError, 'PDF contents navigation'):
                assert_pdf_navigation(report, ET.tostring(root), 'report.pdf')

    def test_pdf_navigation_does_not_join_distant_heading_fragments(self):
        heading='Long'*30
        report=copy.deepcopy(self.report)
        report['presentation']['tableOfContents']=True
        report['sections']=[{'id':'long', 'heading':heading}]
        with self.assertRaisesRegex(ValueError, 'actual section heading'):
            assert_pdf_navigation(report,ET.tostring(self.navigation_xml([heading],gap=True)),'report.pdf')

    def test_spatial_footer_removal_retains_identical_body_sentence(self):
        raw = 'Report body\nPage 1 / 1\nPage 1 / 1\n\f'
        self.assertEqual(pdf_body_with_page_numbers(raw, self.bbox()), 'Report body\nPage 1 / 1')

    def test_missing_wrong_number_or_nonspatial_footer_cannot_pass(self):
        for raw, bbox in [
            ('Report\nPage 2 / 1\n\f', self.bbox()),
            ('Report\nPage 1 / 1\n\f', self.bbox('Page 2 / 1')),
            ('Report\nPage 1 / 1\n\f', self.bbox(y=100)),
            ('Report\nPage 1 / 1\n\f', self.bbox('Page 1 / 1 PRIVATE')),
            ('Report\nPage 1 / 1\n\fOther\f', self.bbox()),
        ]:
            with self.subTest(raw=raw, bbox=bbox), self.assertRaises(ValueError):
                pdf_body_with_page_numbers(raw, bbox)


if __name__ == '__main__':
    unittest.main()
