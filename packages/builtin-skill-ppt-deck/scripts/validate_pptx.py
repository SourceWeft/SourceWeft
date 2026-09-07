#!/usr/bin/env python3
"""Minimal PPTX structural QA for SourceWeft ppt-deck.

Catches package/relationship problems and common PptxGenJS chart faults that
LibreOffice may still render but PowerPoint refuses to open.

Usage:
  python3 validate_pptx.py deck.pptx
  python3 validate_pptx.py deck.pptx --original template.pptx
"""

from __future__ import annotations

import argparse
import math
import re
import sys
import zipfile
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET

CONTENT_TYPES = "[Content_Types].xml"
PRESENTATION = "ppt/presentation.xml"

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

STACKED_GROUPING = frozenset({"stacked", "percentStacked"})


def fail(message: str) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(2)


def load_zip(path: Path) -> zipfile.ZipFile:
    if not path.is_file():
        fail(f"file not found: {path}")
    try:
        return zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        fail(f"not a valid ZIP/PPTX: {path} ({exc})")


def read_xml(zf: zipfile.ZipFile, inner: str) -> ET.Element:
    try:
        data = zf.read(inner)
    except KeyError:
        fail(f"missing required part: {inner}")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        fail(f"invalid XML in {inner}: {exc}")


def list_members(zf: zipfile.ZipFile) -> set[str]:
    return {info.filename for info in zf.infolist() if not info.is_dir()}


def resolve_rel_target(base: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    base_dir = str(Path(base).parent)
    return str(Path(base_dir, target).as_posix())


def owner_part_for_rels(rels_path: str) -> str:
    # ppt/_rels/presentation.xml.rels -> ppt/presentation.xml
    # ppt/slides/_rels/slide1.xml.rels -> ppt/slides/slide1.xml
    name = Path(rels_path).name
    if not name.endswith(".rels"):
        fail(f"unexpected rels path: {rels_path}")
    owner_name = name[: -len(".rels")]
    parent = Path(rels_path).parent
    if parent.name != "_rels":
        fail(f"unexpected rels path: {rels_path}")
    return str((parent.parent / owner_name).as_posix())


def parse_rels(zf: zipfile.ZipFile, rels_path: str, members: set[str]) -> dict[str, str]:
    if rels_path not in members:
        return {}
    root = read_xml(zf, rels_path)
    owner = owner_part_for_rels(rels_path)
    mapping: dict[str, str] = {}
    for rel in root.findall("rel:Relationship", NS):
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target")
        if rid and target and not target.startswith("http"):
            mapping[rid] = resolve_rel_target(owner, target)
    return mapping


def check_package(zf: zipfile.ZipFile, members: set[str], errors: list[str]) -> None:
    if CONTENT_TYPES not in members:
        errors.append(f"missing {CONTENT_TYPES}")
    if PRESENTATION not in members:
        errors.append(f"missing {PRESENTATION}")
        return

    presentation = read_xml(zf, PRESENTATION)
    rels = parse_rels(zf, "ppt/_rels/presentation.xml.rels", members)
    slide_ids = presentation.findall(".//p:sldIdLst/p:sldId", NS)
    if not slide_ids:
        errors.append("presentation.xml has no slides in p:sldIdLst")
        return

    for sld in slide_ids:
        rid = sld.attrib.get(f"{{{NS['r']}}}id")
        if not rid:
            errors.append("slide entry missing r:id")
            continue
        target = rels.get(rid)
        if not target:
            errors.append(f"slide r:id {rid} not found in presentation.xml.rels")
            continue
        if target not in members:
            errors.append(f"slide target missing from package: {target}")


def iter_chart_parts(zf: zipfile.ZipFile, members: set[str]) -> Iterable[str]:
    for name in sorted(members):
        if re.fullmatch(r"ppt/charts/chart\d+\.xml", name):
            yield name


def local(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def chart_is_stacked(chart_root: ET.Element) -> bool:
    for elem in chart_root.iter():
        if local(elem.tag) == "grouping":
            val = (elem.attrib.get("val") or "").strip()
            if val in STACKED_GROUPING:
                return True
    return False


def chart_has_out_end(chart_root: ET.Element) -> bool:
    for elem in chart_root.iter():
        if local(elem.tag) == "dLblPos":
            val = (elem.attrib.get("val") or "").strip()
            if val == "outEnd":
                return True
    return False


def chart_axis_ids(chart_root: ET.Element) -> tuple[set[str], set[str]]:
    declared: set[str] = set()
    for elem in chart_root.iter():
        name = local(elem.tag)
        if name in {"valAx", "catAx", "dateAx", "serAx"}:
            for child in list(elem):
                if local(child.tag) == "axId":
                    val = child.attrib.get("val")
                    if val:
                        declared.add(val)
    referenced: set[str] = set()
    for ser in chart_root.iter():
        if local(ser.tag) != "ser":
            continue
        for child in ser.iter():
            if local(child.tag) == "axId":
                val = child.attrib.get("val")
                if val:
                    referenced.add(val)
    return referenced, declared


def check_charts(zf: zipfile.ZipFile, members: set[str], errors: list[str]) -> None:
    for chart_path in iter_chart_parts(zf, members):
        root = read_xml(zf, chart_path)
        if chart_is_stacked(root) and chart_has_out_end(root):
            errors.append(
                f"{chart_path}: stacked/percentStacked chart uses dLblPos=outEnd "
                "(PowerPoint may refuse this file; use ctr, inEnd, or inBase)"
            )
        referenced, declared = chart_axis_ids(root)
        missing = sorted(referenced - declared)
        if missing:
            errors.append(
                f"{chart_path}: series references undeclared axis id(s) "
                f"{', '.join(missing)} (combo/secondary axis charts need matching valAxes/catAxes)"
            )

    # Ensure chart relationships from slides point to existing parts
    for member in sorted(members):
        if not re.fullmatch(r"ppt/slides/_rels/slide\d+\.xml\.rels", member):
            continue
        rels = parse_rels(zf, member, members)
        for rid, target in rels.items():
            if "charts/" in target and target not in members:
                errors.append(f"{member}: relationship {rid} target missing: {target}")


# DrawingML uses EMUs. A 0.01-inch tolerance avoids rounding-only failures.
BOUNDS_TOLERANCE = 9144
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def compose(left: tuple, right: tuple) -> tuple:
    a, b, c, d, e, f = left
    g, h, i, j, k, l = right
    return (a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f)


def point(matrix: tuple, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return a*x+c*y+e, b*x+d*y+f


def translate(x: float, y: float) -> tuple:
    return (1, 0, 0, 1, x, y)


def rotation(xfrm: ET.Element, x: float, y: float, w: float, h: float) -> tuple:
    angle = math.radians(float(xfrm.get("rot", "0")) / 60000)
    if not math.isfinite(angle):
        raise ValueError("invalid rotation")
    sx = -1 if xfrm.get("flipH") in ("1", "true") else 1
    sy = -1 if xfrm.get("flipV") in ("1", "true") else 1
    matrix = (math.cos(angle)*sx, math.sin(angle)*sx, -math.sin(angle)*sy, math.cos(angle)*sy, 0, 0)
    return compose(translate(x+w/2, y+h/2), compose(matrix, translate(-x-w/2, -y-h/2)))


def geometry(xfrm: ET.Element) -> tuple[float, float, float, float]:
    off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
    if off is None or ext is None:
        raise ValueError("transform is missing offset or extent")
    values = tuple(float(node.attrib[key]) for node, key in ((off,"x"),(off,"y"),(ext,"cx"),(ext,"cy")))
    if not all(math.isfinite(value) for value in values) or values[2] < 0 or values[3] < 0:
        raise ValueError("invalid transform dimensions")
    return values


def check_slide_bounds(zf: zipfile.ZipFile, members: set[str], errors: list[str]) -> None:
    if PRESENTATION not in members:
        return
    size = read_xml(zf, PRESENTATION).find("p:sldSz", NS)
    if size is None:
        errors.append("presentation.xml is missing its slide dimensions")
        return
    width, height = int(size.get("cx", "0")), int(size.get("cy", "0"))
    if width <= 0 or height <= 0:
        errors.append("presentation.xml has invalid slide dimensions")
        return

    def visit(tree: ET.Element, parent: tuple, slide_path: str) -> None:
        for shape in tree:
            kind = local(shape.tag)
            if kind == "grpSp":
                xfrm = shape.find("p:grpSpPr/a:xfrm", NS)
                if xfrm is None:
                    visit(shape, parent, slide_path)
                    continue
                try:
                    x, y, w, h = geometry(xfrm)
                    child_off, child_ext = xfrm.find("a:chOff", NS), xfrm.find("a:chExt", NS)
                    if child_off is None or child_ext is None:
                        raise ValueError("group transform is missing child coordinates")
                    cx, cy = float(child_off.get("x", "0")), float(child_off.get("y", "0"))
                    cw, ch = float(child_ext.get("cx", "0")), float(child_ext.get("cy", "0"))
                    if not all(math.isfinite(value) for value in (cx, cy, cw, ch)) or cw <= 0 or ch <= 0:
                        raise ValueError("group transform has invalid child extents")
                    scaling = (w/cw, 0, 0, h/ch, 0, 0)
                    matrix = compose(rotation(xfrm, x, y, w, h), compose(translate(x,y), compose(scaling, translate(-cx,-cy))))
                    visit(shape, compose(parent, matrix), slide_path)
                except (ValueError, KeyError, OverflowError) as exc:
                    errors.append(f"{slide_path}: {exc}")
                continue
            # Background/bleed geometry is allowed outside the canvas. Check
            # text-bearing shapes and data frames, not decorative empty shapes.
            if kind not in ("sp", "graphicFrame"):
                continue
            if kind == "sp" and not any((node.text or "").strip() for node in shape.findall(".//a:t", NS)):
                continue
            xfrm = shape.find("p:spPr/a:xfrm", NS) if kind == "sp" else shape.find("p:xfrm", NS)
            if xfrm is None:
                continue  # Placeholder coordinates can be inherited from a layout.
            name_node = shape.find(".//p:cNvPr", NS)
            name = name_node.get("name", kind) if name_node is not None else kind
            try:
                x, y, w, h = geometry(xfrm)
                matrix = compose(parent, rotation(xfrm, x, y, w, h))
                corners = [point(matrix, px, py) for px, py in ((x,y),(x+w,y),(x+w,y+h),(x,y+h))]
                if any(px < -BOUNDS_TOLERANCE or py < -BOUNDS_TOLERANCE or px > width+BOUNDS_TOLERANCE or py > height+BOUNDS_TOLERANCE for px, py in corners):
                    errors.append(f"{slide_path}: {name!r} text/data extends outside slide bounds ({width/914400:g} x {height/914400:g} inches)")
            except (ValueError, KeyError, OverflowError) as exc:
                errors.append(f"{slide_path}: {name!r}: {exc}")

    for slide_path in sorted(members):
        if re.fullmatch(r"ppt/slides/slide\d+\.xml", slide_path):
            tree = read_xml(zf, slide_path).find("p:cSld/p:spTree", NS)
            if tree is not None:
                visit(tree, IDENTITY, slide_path)


def package_issues(path: Path) -> list[str]:
    errors: list[str] = []
    with load_zip(path) as zf:
        members = list_members(zf)
        check_package(zf, members, errors)
        check_charts(zf, members, errors)
        check_slide_bounds(zf, members, errors)
    return errors


def baseline_suppress(current: list[str], original: list[str]) -> list[str]:
    original_set = set(original)
    return [item for item in current if "text/data extends outside slide bounds" in item or item not in original_set]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate PPTX package, chart structure and text/data slide bounds")
    parser.add_argument("path", help="Path to a .pptx file")
    parser.add_argument(
        "--original",
        default=None,
        help="Optional template/source PPTX; suppress issues already present there",
    )
    args = parser.parse_args(argv)

    path = Path(args.path)
    errors = package_issues(path)
    if args.original:
        original_errors = package_issues(Path(args.original))
        errors = baseline_suppress(errors, original_errors)

    if errors:
        print(f"FAIL {path}")
        for item in errors:
            print(f"- {item}")
        return 1

    print(f"OK {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
