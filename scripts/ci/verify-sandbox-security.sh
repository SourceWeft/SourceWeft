#!/usr/bin/env bash
set -euo pipefail

# Runs inside either real sandbox image, as its configured non-root user and
# with Docker networking disabled. Skill files are mounted read-only by CI.
test "$(id -u)" != 0
test "$(uname -m)" = x86_64
python3 - <<'PY'
import importlib.metadata
import sys
import brotli
assert sys.version_info[:2] == (3, 11), sys.version
assert importlib.metadata.version('fonttools') == '4.60.2'
assert importlib.metadata.version('Brotli') == '1.2.0'
payload = b'SourceWeft WOFF2 security regression' * 32
assert brotli.decompress(brotli.compress(payload)) == payload
print('Python 3.11, fontTools 4.60.2, Brotli 1.2.0 and compression round-trip verified')
PY

security_work_dir="$(mktemp -d /tmp/sourceweft-security.XXXXXX)"
trap 'rm -rf "$security_work_dir"' EXIT
cat > "$security_work_dir/page.html" <<'HTML'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>离线报告</title><style>body{font-family:'Noto Sans SC';padding:24px;font-size:24px}</style></head><body><h1>字体完整，内容可读。</h1><p>Offline HTML with embedded fonts.</p></body></html>
HTML
node /skills/html/scripts/build.cjs "$security_work_dir/page.html" "$security_work_dir/index.html"
node /skills/html/scripts/qa.cjs "$security_work_dir/index.html" "$security_work_dir/page-qa"
cat > "$security_work_dir/slides.html" <<'HTML'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>离线演示</title></head><body><section data-slide-id="one"><h1 class="h1">安全依赖，完整交付。</h1><p>Fonts travel with this file.</p></section><section data-slide-id="two"><h2 class="h2">第二页</h2><p class="fragment">发布与验证使用同一份文件。</p></section></body></html>
HTML
node /skills/html-slides/scripts/build.cjs "$security_work_dir/slides.html" "$security_work_dir/deck.html" --theme=minimal-white --ratio=16:9
node /skills/html-slides/scripts/qa.cjs "$security_work_dir/deck.html" "$security_work_dir/slides-qa"
node - "$security_work_dir" <<'JS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
for (const [file, directory] of [['index.html', 'page-qa'], ['deck.html', 'slides-qa']]) {
  const root = process.argv[2];
  const qa = JSON.parse(fs.readFileSync(path.join(root, directory, 'qa.json'), 'utf8'));
  assert.equal(qa.passed, true);
  const digest = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  assert.equal(qa.contentDigest, digest);
}
console.log('Non-root offline page and presentation builds, glyph QA, and final-file digests passed');
JS
