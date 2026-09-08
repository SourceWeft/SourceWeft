"""Image-build-only provisioning. Rendering never downloads missing fonts."""
import hashlib
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlparse

manifest = Path(sys.argv[1])
target = Path(sys.argv[2]).resolve()
catalog = json.loads(manifest.read_text())
target.mkdir(parents=True, exist_ok=True)
for item in catalog['files']:
    url = urlparse(item['url'])
    expected_prefix = '/google/fonts/' + catalog['sourceCommit'] + '/'
    if url.scheme != 'https' or url.hostname != 'raw.githubusercontent.com' or not url.path.startswith(expected_prefix):
        raise ValueError('Font source is not pinned to the declared official commit')
    destination = (target / item['path']).resolve()
    if target not in destination.parents:
        raise ValueError('Font path escapes installation directory')
    if destination.exists():
        cached = destination.read_bytes()
        if len(cached) == item['bytes'] and hashlib.sha256(cached).hexdigest() == item['sha256']:
            continue
        print('Cached font failed integrity; fetching the pinned source: ' + item['path'])
    with urlopen(Request(item['url'], headers={'User-Agent': 'SourceWeft-sandbox-fonts'}), timeout=60) as response:
        content = response.read(item['bytes'] + 1)
    if len(content) != item['bytes'] or hashlib.sha256(content).hexdigest() != item['sha256']:
        raise ValueError('Font size/digest mismatch: ' + item['path'])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
(target / 'catalog.json').write_text(json.dumps(catalog, indent=2) + '\n')
print('Pinned HTML fonts installed:', len(catalog['files']))
