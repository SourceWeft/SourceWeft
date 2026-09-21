"""Image-build-only provisioning. Rendering never downloads missing fonts."""
import hashlib
import json
import sys
import time
from http.client import HTTPException
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlparse

# One dropped connection must not cost the whole image layer this runs in (a
# quarter of an hour under emulation). Only the transfer is retried: what was
# fetched is still checked against the pinned size and digest below.
FETCH_ATTEMPTS = 4


def fetch(url, limit):
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'SourceWeft-sandbox-fonts'}), timeout=60) as response:
                return response.read(limit)
        except (OSError, HTTPException) as error:  # URLError, TLS and socket errors are OSError
            if attempt == FETCH_ATTEMPTS:
                raise
            print('Font download failed (%s); retry %d of %d: %s' % (error, attempt, FETCH_ATTEMPTS - 1, url))
            time.sleep(2 ** attempt)


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
    content = fetch(item['url'], item['bytes'] + 1)
    if len(content) != item['bytes'] or hashlib.sha256(content).hexdigest() != item['sha256']:
        raise ValueError('Font size/digest mismatch: ' + item['path'])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
(target / 'catalog.json').write_text(json.dumps(catalog, indent=2) + '\n')
print('Pinned HTML fonts installed:', len(catalog['files']))
