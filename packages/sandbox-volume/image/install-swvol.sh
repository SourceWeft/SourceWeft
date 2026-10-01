#!/bin/sh
# Image layer shared by every sandbox image (Cloudflare bridge image, Daytona snapshot).
# Expects the helper binaries next to this script (helper/dist/*) and installs:
#   /usr/local/sbin/swvol, /usr/local/sbin/swlazy   root-owned, 0755
#   /usr/local/sbin/swvol-init                       the root boot step (FUSE lower + overlay upper)
#   system user `swvol` (the daemon's identity), fuse3 with user_allow_other
# The sandbox user must NOT have sudo in the final image.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
arch="$(uname -m)"
case "$arch" in x86_64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac
if command -v apt-get >/dev/null 2>&1; then
  apt-get update && apt-get install -y --no-install-recommends fuse3 util-linux && rm -rf /var/lib/apt/lists/*
fi
grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null || echo user_allow_other >> /etc/fuse.conf
id swvol >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin swvol
install -o root -g root -m 0755 "$here/swvol-$arch" /usr/local/sbin/swvol
install -o root -g root -m 0755 "$here/swlazy-$arch" /usr/local/sbin/swlazy
install -o root -g root -m 0755 "$here/swvol-init" /usr/local/sbin/swvol-init
mkdir -p /var/lib/swvol /usr/local/share/swvol && chown swvol:swvol /var/lib/swvol && chmod 700 /var/lib/swvol
cp "$here/VERSION" /usr/local/share/swvol/VERSION
