#!/usr/bin/env bash
set -euo pipefail

# Run in the current sandbox image, as its configured non-root user, offline.
# Mount the report skill read-only at /skills/report; never install dependencies.
test "$(id -u)" != 0
report_root="${1:-$(mktemp -d /tmp/sourceweft-report.XXXXXX)}"
mkdir -p "$report_root"
report_skill=/skills/report
report_formats=html,md,docx,pdf

build_report() {
  local report_source="$1" report_output="$2"
  python3 -B "$report_skill/scripts/generate_report.py" --source "$report_source" --output-dir "$report_output" --formats "$report_formats"
  node "$report_skill/scripts/build-html.cjs" "$report_output/draft.html" "$report_output/report.html"
  node "$report_skill/scripts/qa-html.cjs" "$report_output/report.html" "$report_output/qa" > "$report_output/html-qa.log"
  python3 -B "$report_skill/scripts/verify_report.py" --source "$report_source" --output-dir "$report_output" --formats "$report_formats" > "$report_output/verification.json"
  mkdir "$report_output/pdf-pages"
  pdftoppm -scale-to 1600 -png "$report_output/report.pdf" "$report_output/pdf-pages/page"
}

build_report "$report_skill/tests/fixtures/comparison.source.json" "$report_root/original"
python3 -B - "$report_root" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
original = root / 'original'
source = json.loads((original / 'report.source.json').read_text())
# A concrete edit through the same immutable source format, not a new fact.
source['summary'].append({'text': '下一步安排小规模试用，并核实冲突的团队人数与尚未公开的价格。', 'kind': 'recommendation', 'citations': ['S1', 'S2', 'S3']})
(root / 'revision.source.json').write_text(json.dumps(source, ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'original-digests.json').write_text(json.dumps({name: hashlib.sha256((original / name).read_bytes()).hexdigest() for name in ['report.html','report.md','report.docx','report.pdf','report.source.json']}))
PY
build_report "$report_root/revision.source.json" "$report_root/revised"
python3 -B - "$report_root" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
old = json.loads((root / 'original-digests.json').read_text())
for version in ['original', 'revised']:
    folder = root / version
    verification = json.loads((folder / 'verification.json').read_text())
    qa = json.loads((folder / 'qa/qa.json').read_text())
    assert verification['passed'] and qa['passed']
    assert verification['evidenceAuthenticated'] is False
    assert len(verification['files']) == 4
    assert len(qa['checks']) == 3
    assert list((folder / 'pdf-pages').glob('page-*.png'))
    assert qa['contentDigest'] == 'sha256:' + hashlib.sha256((folder / 'report.html').read_bytes()).hexdigest()
    for file in verification['files']:
        data = (folder / file['fileName']).read_bytes()
        assert len(data) == file['byteLength']
        assert file['contentDigest'] == 'sha256:' + hashlib.sha256(data).hexdigest()
for name, digest in old.items():
    assert hashlib.sha256((root / 'original' / name).read_bytes()).hexdigest() == digest
    assert hashlib.sha256((root / 'revised' / name).read_bytes()).hexdigest() != digest
print('Offline non-root report generation, all four formats, three HTML viewports, revision and unchanged original bytes verified; factual/visual certification is separate.')
PY

# Optional presentation is part of the private frozen source, not turn-local CSS.
# Legacy comparison above remains the default/short case. This custom case must
# actually span PDF pages with repeated headings, real PAGE/NUMPAGES and no lost
# rows. The native validator records page count dynamically rather than assuming
# the same pagination on the two provisioned images.
report_long_fixture="$report_skill/tests/fixtures/long-table.source.json"
build_report "$report_long_fixture" "$report_root/long-table"
python3 -B "$report_skill/tests/test_report_qualification.py" --qualify-layout \
  "$report_long_fixture" "$report_root/long-table"
python3 -B - "$report_root" <<'PYRESTORE'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
original = root/'long-table'
source = json.loads((original/'report.source.json').read_text())
(root/'long-table-digests.json').write_text(json.dumps({name: hashlib.sha256((original/name).read_bytes()).hexdigest() for name in ['report.html','report.md','report.docx','report.pdf','report.source.json']}))
source['summary'][0]['text'] += ' 修订仅增加这句测试说明。'
(root/'long-table-revision.source.json').write_text(json.dumps(source, ensure_ascii=False, indent=2))
PYRESTORE
build_report "$report_root/long-table-revision.source.json" "$report_root/long-table-revised"
python3 -B "$report_skill/tests/test_report_qualification.py" --qualify-layout \
  "$report_root/long-table-revision.source.json" "$report_root/long-table-revised"
python3 -B - "$report_root" <<'PYPRESERVE'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
original = json.loads((root/'long-table/report.source.json').read_text())
revised = json.loads((root/'long-table-revised/report.source.json').read_text())
expected = json.loads(json.dumps(original))
expected['summary'][0]['text'] += ' 修订仅增加这句测试说明。'
assert revised == expected, 'Restoration changed presentation, facts, dates, sources or structure'
for name, digest in json.loads((root/'long-table-digests.json').read_text()).items():
    assert hashlib.sha256((root/'long-table'/name).read_bytes()).hexdigest() == digest
    assert hashlib.sha256((root/'long-table-revised'/name).read_bytes()).hexdigest() != digest
for name in ['long-table', 'long-table-revised']:
    output = root/name
    assert json.loads((output/'verification.json').read_text())['passed'] is True
    qa = json.loads((output/'qa/qa.json').read_text())
    assert qa['passed'] is True and qa['unchanged'] is True
    assert len(qa['checks']) == 3
    assert all(check['height'] <= 12000 for check in qa['checks'])
    assert qa['contentDigest'] == 'sha256:' + hashlib.sha256((output/'report.html').read_bytes()).hexdigest()
print('Custom frozen presentation restored; all four revised formats pass, real PDF page fields and repeated table headers checked, original bytes unchanged.')
PYPRESERVE

# A clickable PDF TOC is a real export requirement. Preserve every visible run,
# bookmark and footer but remove the actual internal hyperlink wrappers from a
# copy of the generated DOCX; the same LibreOffice must produce a PDF whose
# content still verifies while navigation qualification rejects it.
python3 -B - "$report_root" "$report_skill" <<'PYNAVIGATION'
import hashlib, json, shutil, subprocess, sys, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
root, skill = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(skill/'scripts'))
from verify_report import assert_content, docx_text, pdf_body_with_page_numbers
from report_schema import read_report
original = root/'long-table'
negative = root/'navigation-negative'
negative.mkdir()
for name in ['report.html', 'report.md', 'report.docx', 'report.pdf', 'report.source.json']:
    shutil.copyfile(original/name, negative/name)
namespace = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(original/'report.docx') as archive:
    parts = [(info, archive.read(info.filename)) for info in archive.infolist()]
document = ET.fromstring(dict((info.filename, data) for info, data in parts)['word/document.xml'])
removed = 0
for parent in document.iter():
    for link in list(parent):
        if link.tag == namespace+'hyperlink' and link.get(namespace+'anchor'):
            index = list(parent).index(link)
            for offset, child in enumerate(list(link)):
                parent.insert(index+offset, child)
            parent.remove(link)
            removed += 1
assert removed == 2, 'Negative must actually remove the fixed fixture contents links'
with zipfile.ZipFile(negative/'report.docx', 'w') as archive:
    for info, data in parts:
        archive.writestr(info, ET.tostring(document, encoding='utf-8', xml_declaration=True) if info.filename == 'word/document.xml' else data)
converted = negative/'converted'
converted.mkdir()
subprocess.run(['soffice', '-env:UserInstallation='+(negative/'office-profile').resolve().as_uri(), '--headless', '--convert-to', 'pdf', '--outdir', str(converted), str((negative/'report.docx').resolve())], check=True, timeout=90, stdout=subprocess.DEVNULL)
assert (converted/'report.pdf').is_file() and (converted/'report.pdf').stat().st_size > 0
shutil.copyfile(converted/'report.pdf', negative/'report.pdf')
# Keep the deliberately stripped conversion input as evidence, then restore the
# valid DOCX deliverable. Its independent navigation guard must not mask the PDF
# navigation defect that this negative isolates.
(negative/'report.docx').rename(negative/'no-links.input.docx')
shutil.copyfile(original/'report.docx', negative/'report.docx')
source = read_report(skill/'tests/fixtures/long-table.source.json')
assert_content(source, docx_text(negative/'report.docx', source), 'DOCX')
raw = subprocess.run(['pdftotext', '-raw', str(negative/'report.pdf'), '-'], capture_output=True, text=True, check=True, timeout=30).stdout
bbox = subprocess.run(['pdftotext', '-bbox', str(negative/'report.pdf'), '-'], capture_output=True, text=True, check=True, timeout=30).stdout
assert_content(source, pdf_body_with_page_numbers(raw, bbox), 'PDF', ordered=False)
for name in ['report.html', 'report.md', 'report.source.json']:
    assert (original/name).read_bytes() == (negative/name).read_bytes()
result = {'bodyContentPreserved': True, 'controlledDocxAndPdfFootersValid': True, 'htmlMarkdownAndSourceBytesUnchanged': True, 'navigationPassed': False, 'scope': 'Body/footer preservation only; actual navigation must independently reject this candidate'}
assert hashlib.sha256((original/'report.pdf').read_bytes()).digest() != hashlib.sha256((negative/'report.pdf').read_bytes()).digest()
(negative/'content-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
PYNAVIGATION
if python3 -B "$report_skill/tests/test_report_qualification.py" --qualify-navigation \
  "$report_long_fixture" "$report_root/navigation-negative/report.pdf" \
  > "$report_root/navigation-negative/rejected.json" 2> "$report_root/navigation-negative/rejected.log"; then
  echo 'Unexpectedly accepted a PDF with painted contents labels but no clickable links' >&2
  exit 1
fi
python3 -B - "$report_root/navigation-negative" <<'PYNAVREJECT'
import sys
from pathlib import Path
root = Path(sys.argv[1])
assert 'PDF contents needs exactly one actual clickable internal link per section heading' in (root/'rejected.log').read_text(), 'Expected actual missing-link rejection, not missing tools or malformed content'
print('Real same-engine PDF navigation negative rejected: contents labels and all body/footer text survive while clickable links are absent.')
PYNAVREJECT
if python3 -B "$report_skill/scripts/verify_report.py" --source "$report_long_fixture" \
  --output-dir "$report_root/navigation-negative" --formats "$report_formats" \
  > "$report_root/navigation-negative/verifier-rejected.json" 2> "$report_root/navigation-negative/verifier-rejected.log"; then
  echo 'Production verification unexpectedly accepted an unclickable PDF table of contents' >&2
  exit 1
fi
python3 -B - "$report_root/navigation-negative" <<'PYVERIFIERNAV'
import sys
from pathlib import Path
root = Path(sys.argv[1])
assert 'PDF contents navigation' in (root/'verifier-rejected.log').read_text(), 'Expected production navigation rejection, not another content/dependency failure'
print('Production verification independently rejects the same real PDF solely for missing contents navigation.')
PYVERIFIERNAV

# A valid source can exceed the existing standard browser budget. Exercise the
# actual bundler/browser and require its specific nonzero height rejection; a
# missing font, crash or swallowed exit status is not an acceptable negative.
python3 -B - "$report_root" "$report_long_fixture" <<'PYOVERSIZE'
import json, sys
from pathlib import Path
root, fixture = Path(sys.argv[1]), Path(sys.argv[2])
source = json.loads(fixture.read_text())
source['title'] = '虚构超标准高度回归报告'
source['presentation'] = {'mobileDensity': 'standard'}
source['sections'] = [{'id': 'oversize', 'heading': '保留全部正文的高度负例', 'blocks': [
    {'type': 'paragraph', 'text': f'段落{i:02d}。' + '本段为虚构回归正文，必须原样保留以验证标准高度限制，不能通过删除内容或缩小文字绕过检查。' * 25, 'kind': 'analysis', 'citations': []}
    for i in range(20)
]}]
(root/'oversize.source.json').write_text(json.dumps(source, ensure_ascii=False, indent=2))
PYOVERSIZE
python3 -B "$report_skill/scripts/generate_report.py" --source "$report_root/oversize.source.json" \
  --output-dir "$report_root/oversize" --formats html,md
node "$report_skill/scripts/build-html.cjs" "$report_root/oversize/draft.html" "$report_root/oversize/report.html"
if node "$report_skill/scripts/qa-html.cjs" "$report_root/oversize/report.html" "$report_root/oversize/qa" > "$report_root/oversize/html-qa.log" 2> "$report_root/oversize/html-qa-error.log"; then
  echo 'Unexpectedly accepted a report above the standard height budget' >&2
  exit 1
fi
python3 -B - "$report_root/oversize" <<'PYREJECT'
import hashlib, json, sys
from pathlib import Path
output = Path(sys.argv[1])
qa = json.loads((output/'qa/qa.json').read_text())
assert qa['passed'] is False and qa['unchanged'] is True
assert len(qa['checks']) == 3
assert qa['contentDigest'] == 'sha256:' + hashlib.sha256((output/'report.html').read_bytes()).hexdigest()
assert any(check['height'] > 12000 and 'Report exceeds the existing 12,000px QA height budget' in check['issues'] for check in qa['checks']), 'Expected an actual height rejection, not a browser/dependency failure'
assert all(not check['violations'] for check in qa['checks'])
print('Actual standard-height rejection verified without changing the budget or dropping source content.')
PYREJECT

# Content-stream regression: adjacent long cells and two dates remain intact.
# This is not a layout-mode fallback: the selected production mode is always raw.
report_pdf_regression="$report_root/pdf-reading-order-regression"
mkdir "$report_pdf_regression"
report_pdf_fixture="$report_skill/tests/fixtures/pdf-multicolumn.source.json"
build_report "$report_pdf_fixture" "$report_pdf_regression/baseline"
python3 -B - "$report_pdf_regression" "$report_skill" <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1])
skill = Path(sys.argv[2])
sys.path.insert(0, str(skill/'scripts'))
from report_schema import read_report, public_texts
from verify_report import assert_content, normalized
source = read_report(skill/'tests/fixtures/pdf-multicolumn.source.json')
pdf = root/'baseline/report.pdf'
modes = []
for mode in ['-layout', '-raw']:
    result = subprocess.run(['pdftotext', mode, str(pdf), '-'], capture_output=True, text=True, timeout=30, check=True)
    support = [normalized(item) in normalized(result.stdout) for item in public_texts(source)]
    try:
        assert_content(source, result.stdout, 'PDF', ordered=False)
        passed = True
    except ValueError:
        passed = False
    modes.append({'mode': mode, 'passed': passed, 'supportedFragments': sum(support), 'expectedFragments': len(support)})
    if mode == '-layout':
        assert not passed, 'This fixture must actually reproduce interleaved layout extraction'
    if mode == '-raw':
        assert passed and all(support), 'Raw extraction must retain every complete source fragment'
(root/'mode-evidence.json').write_text(json.dumps(modes, indent=2))
(root/'baseline-digests.json').write_text(json.dumps({name: hashlib.sha256((root/'baseline'/name).read_bytes()).hexdigest() for name in ['report.html', 'report.md', 'report.docx', 'report.pdf', 'report.source.json']}))
for name in ['missing-character', 'changed-date', 'missing-citation']:
    mutation = json.loads(json.dumps(source))
    blocks = mutation['sections'][0]['blocks']
    if name == 'missing-character':
        blocks[0]['rows'][0][2]['text'] = blocks[0]['rows'][0][2]['text'].replace('字符', '符')
    elif name == 'changed-date':
        blocks[0]['rows'][0][1]['text'] = blocks[0]['rows'][0][1]['text'].replace('2026-07-16', '2026-07-17')
    else:
        blocks[1]['citations'] = []
    (root/(name+'.input.json')).write_text(json.dumps(mutation, ensure_ascii=False, indent=2))
PY
for report_bad_case in missing-character changed-date missing-citation; do
  # Generate a genuinely different PDF using the same python-docx/LO path.
  python3 -B "$report_skill/scripts/generate_report.py" \
    --source "$report_pdf_regression/$report_bad_case.input.json" \
    --output-dir "$report_pdf_regression/$report_bad_case.generated" --formats html,pdf
  mkdir "$report_pdf_regression/$report_bad_case.check"
  cp "$report_pdf_regression/baseline/"report.* "$report_pdf_regression/$report_bad_case.check/"
  cp "$report_pdf_regression/$report_bad_case.generated/report.pdf" "$report_pdf_regression/$report_bad_case.check/report.pdf"
  if python3 -B "$report_skill/scripts/verify_report.py" --source "$report_pdf_fixture" \
    --output-dir "$report_pdf_regression/$report_bad_case.check" --formats "$report_formats" \
    > "$report_pdf_regression/$report_bad_case.check/rejected.json" \
    2> "$report_pdf_regression/$report_bad_case.check/rejected.log"; then
    echo "Unexpectedly accepted $report_bad_case PDF" >&2
    exit 1
  fi
  python3 -B - "$report_pdf_regression" "$report_bad_case" <<'PY'
import hashlib, sys
from pathlib import Path
root, name = Path(sys.argv[1]), sys.argv[2]
original = root/'baseline/report.pdf'
mutated = root/(name+'.check')/'report.pdf'
assert hashlib.sha256(original.read_bytes()).digest() != hashlib.sha256(mutated.read_bytes()).digest()
assert 'PDF content differs' in (root/(name+'.check')/'rejected.log').read_text(), 'Expected an actual content rejection, not a missing file/dependency error'
PY
done
python3 -B - "$report_pdf_regression" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
for name, digest in json.loads((root/'baseline-digests.json').read_text()).items():
    assert hashlib.sha256((root/'baseline'/name).read_bytes()).hexdigest() == digest
print('Same-engine native PDF regression passed: every source fragment retained; genuinely different PDFs with a missing character, changed date or missing citation rejected; baseline unchanged.')
PY
