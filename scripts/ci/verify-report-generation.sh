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
