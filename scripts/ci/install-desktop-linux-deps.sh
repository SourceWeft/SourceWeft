#!/usr/bin/env bash
set -euo pipefail
# Ubuntu 22.04 is the supported glibc baseline for the Linux AppImage.
apt-get update
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl wget file xz-utils \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev \
  libssl-dev librsvg2-dev patchelf libfuse2 \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
