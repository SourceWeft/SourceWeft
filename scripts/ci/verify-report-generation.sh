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
