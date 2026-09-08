"""Subset only checked, explicitly provisioned fonts; emit CSS and glyph evidence."""
import base64
import hashlib
import io
import json
import sys
import unicodedata
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont


def generate(request):
    directory = Path(request['directory']).resolve()
    catalog = json.loads((directory / 'catalog.json').read_text())
    characters = {ord(c) for c in request['text'] if unicodedata.category(c) not in ('Cc', 'Cs')}
    required = {c for c in characters if unicodedata.category(chr(c)) != 'Cf' and not 0xFE00 <= c <= 0xFE0F and not 0xE0100 <= c <= 0xE01EF}
    characters.update(range(32, 127))
    families = set(request['families'])
    available = []
    covered = set()
    family_coverage = {}
    css = []
    notices = []
    for entry in catalog['files']:
        if entry['family'] not in families:
            continue
        path = (directory / entry['path']).resolve()
        if directory not in path.parents:
            raise ValueError('Font catalog path escapes the font directory')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError('Font digest mismatch: ' + entry['path'])
        if path.suffix == '.txt':
            notices.append({'family': entry['family'], 'license': raw.decode('utf-8')})
            continue
        font = TTFont(io.BytesIO(raw), recalcTimestamp=False)
        cmap = font.getBestCmap() or {}
        requested = characters.intersection(cmap)
        if not requested:
            font.close()
            continue
        covered.update(requested)
        family_coverage.setdefault(entry['family'], set()).update(requested)
        available.append(entry['family'])
        weight = str(font['OS/2'].usWeightClass)
        if 'fvar' in font:
            axis = next((a for a in font['fvar'].axes if a.axisTag == 'wght'), None)
            if axis:
                weight = f'{int(axis.minValue)} {int(axis.maxValue)}'
        style = 'italic' if font['head'].macStyle & 2 or 'Italic' in path.name else 'normal'
        options = subset.Options()
        options.flavor = 'woff2'
        options.harfbuzz_repacker = False
        options.ignore_missing_unicodes = False
        options.ignore_missing_glyphs = False
        options.layout_features = ['*']
        processor = subset.Subsetter(options=options)
        processor.populate(unicodes=requested)
        processor.subset(font)
        font.flavor = 'woff2'
        output = io.BytesIO()
        font.save(output)
        font.close()
        encoded = base64.b64encode(output.getvalue()).decode('ascii')
        family = entry['family'].replace("'", "\\'")
        css.append(f"@font-face{{font-family:'{family}';font-style:{style};font-weight:{weight};font-display:block;src:url(data:font/woff2;base64,{encoded}) format('woff2')}}")
    missing_families = families.difference(available)
    if missing_families:
        raise ValueError('Unprovisioned font families: ' + ', '.join(sorted(missing_families)))
    missing = required.difference(covered)
    if missing:
        raise ValueError('Missing glyphs: ' + ', '.join(f'U+{c:04X}' for c in sorted(missing)[:30]))
    return {'css': '\n'.join(css), 'codepoints': sorted(covered), 'families': sorted(set(available)), 'familyCodepoints': {name: sorted(points) for name, points in family_coverage.items()}, 'licenses': notices}


if __name__ == '__main__':
    try:
        print(json.dumps(generate(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print('HTML_FONT_ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
