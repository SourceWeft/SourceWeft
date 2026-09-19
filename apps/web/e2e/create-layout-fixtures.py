"""Create tiny local PNG fixtures for the compact-layout draft attachment check."""
from pathlib import Path
import struct
import sys
import zlib

output = Path(sys.argv[1] if len(sys.argv) > 1 else "output/playwright/pc-compact/fixtures")
output.mkdir(parents=True, exist_ok=True)


def chunk(tag: bytes, data: bytes) -> bytes:
    checksum = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", checksum)


for index in range(8):
    rows = b"".join(b"\x00" + bytes([40 + index * 15, 90, 130, 255]) * 32 for _ in range(32))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!2I5B", 32, 32, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )
    (output / f"layout-{index + 1}.png").write_bytes(png)

print(f"Created 8 local attachment fixtures in {output}")
