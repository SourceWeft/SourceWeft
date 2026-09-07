import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("validator", Path(__file__).parents[1] / "scripts" / "validate_pptx.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def text_shape(y, height, x=100000, width=1000000, rotation=0):
    return f'<p:sp><p:nvSpPr><p:cNvPr id="1" name="Total"/></p:nvSpPr><p:spPr><a:xfrm rot="{rotation}"><a:off x="{x}" y="{y}"/><a:ext cx="{width}" cy="{height}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>226</a:t></a:r></a:p></p:txBody></p:sp>'


class BoundsTest(unittest.TestCase):
    def validate(self, body):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deck.pptx"
            with zipfile.ZipFile(path, "w") as z:
                z.writestr("[Content_Types].xml", "<Types/>")
                z.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{validator.NS["p"]}" xmlns:r="{validator.NS["r"]}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>')
                z.writestr("ppt/_rels/presentation.xml.rels", f'<Relationships xmlns="{validator.NS["rel"]}"><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>')
                z.writestr("ppt/slides/slide1.xml", f'<p:sld xmlns:p="{validator.NS["p"]}" xmlns:a="{validator.NS["a"]}"><p:cSld><p:spTree>{body}</p:spTree></p:cSld></p:sld>')
            return validator.package_issues(path)

    def test_footer_is_checked_against_actual_16x9_height(self):
        self.assertIn("outside slide bounds", " ".join(self.validate(text_shape(4600000, 914400))))
        self.assertEqual(self.validate(text_shape(3800000, 914400)), [])

    def test_existing_text_overflow_cannot_be_suppressed_as_a_template_issue(self):
        issues = self.validate(text_shape(4600000, 914400))
        self.assertEqual(validator.baseline_suppress(issues, issues), issues)

    def test_group_translation_and_scaling_are_applied(self):
        child = text_shape(0, 100000)
        group = f'<p:grpSp><p:grpSpPr><a:xfrm><a:off x="0" y="5100000"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr>{child}</p:grpSp>'
        self.assertIn("outside slide bounds", " ".join(self.validate(group)))

    def test_rotation_uses_transformed_bounds(self):
        self.assertEqual(self.validate(text_shape(2000000, 100000, x=2000000, rotation=5400000)), [])
        self.assertIn("outside slide bounds", " ".join(self.validate(text_shape(0, 100000, rotation=5400000))))

    def test_background_bleed_is_not_rejected_as_text_overflow(self):
        background = '<p:sp><p:spPr><a:xfrm><a:off x="-100000" y="-100000"/><a:ext cx="9500000" cy="5500000"/></a:xfrm></p:spPr></p:sp>'
        self.assertEqual(self.validate(background + text_shape(100000, 100000)), [])


if __name__ == "__main__":
    unittest.main()
