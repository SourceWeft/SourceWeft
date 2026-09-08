"""Generate isolated billing-regression inputs with Python's standard library.

The EPUB intentionally has one spine chapter and the CSV one data record, while
both exceed a standard text page. The RTF has no physical-page metadata. The
PDF is the repository's real two-page fixture with little text.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED
import csv
import io
import json

root = Path(__file__).resolve().parents[2]
output = root / "output/playwright/anydoc-billing/fixtures"
output.mkdir(parents=True, exist_ok=True)
paragraph = "Billing evidence cobalt orchard. A text standard page follows parsed content length, not file format or record count. "
rtf_body = "\\par\n".join(paragraph + f"Paragraph {i}." for i in range(100))
(output / "billing-long.rtf").write_text("{\\rtf1\\ansi\n" + rtf_body + "\n}", encoding="ascii")

csv_buffer = io.StringIO(newline="")
writer = csv.writer(csv_buffer)
writer.writerow(["title", "body"])
writer.writerow(["One long CSV record", paragraph * 50])
(output / "billing-long.csv").write_text(csv_buffer.getvalue(), encoding="utf8")

chapter = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One long chapter</title></head><body><h1>One long EPUB chapter</h1>'
chapter += "".join(f"<p>{paragraph}Section {i}.</p>" for i in range(50))
chapter += "</body></html>"
source = root / "packages/builtin-document-parsers/tests/fixtures/anydoc/sample.epub"
with ZipFile(source) as original, ZipFile(output / "billing-long.epub", "w") as result:
    for name in original.namelist():
        data = chapter.encode() if name == "chapter.xhtml" else original.read(name)
        result.writestr(name, data, compress_type=ZIP_STORED if name == "mimetype" else ZIP_DEFLATED)

pdf = root / "packages/builtin-document-parsers/tests/fixtures/anydoc/text.pdf"
(output / "billing-two-pages.pdf").write_bytes(pdf.read_bytes())
expectations = {
    "billing-long.rtf": {"minParsedChars": 8001, "kind": "text"},
    "billing-long.csv": {"minParsedChars": 4001, "kind": "text", "inputRecordCount": 1},
    "billing-long.epub": {"minParsedChars": 4001, "kind": "text", "inputChapterCount": 1},
    "billing-two-pages.pdf": {"physicalPages": 2, "kind": "pdf"},
}
(output.parent / "fixture-expectations.json").write_text(json.dumps(expectations, indent=2))
print(f"Created four billing fixtures in {output}")
