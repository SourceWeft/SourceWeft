#!/usr/bin/env bash
# ── SourceWeft sandbox base provisioning ────────────────────────────────────
# Single source of truth for the tooling every SourceWeft sandbox must expose,
# so the `daytona` and `cloudflare` providers present a byte-for-byte identical
# base environment and cannot drift apart.
#
# Consumed by BOTH sandbox images (each COPYs this file and RUNs it):
#   • docker/sourceweft-sandbox/Dockerfile                    (FROM debian:bookworm-slim)
#   • packages/sandbox-provider-cloudflare/bridge/Dockerfile  (FROM cloudflare/sandbox)
#
# This script installs ONLY system-wide tooling into fixed, world-readable
# paths (/usr/local, /opt, /pnpm). It deliberately does NOT create the sandbox
# user or chown the workspace — that is provider-specific (Daytona uses
# `sourceweft`, Cloudflare uses `sandbox`) and each Dockerfile owns it. The
# matching ENV declarations (PATH, PNPM_HOME, VIRTUAL_ENV, PLAYWRIGHT_BROWSERS_PATH,
# SOURCEWEFT_REMOTION_BROWSER, SOURCEWEFT_PNPM_STORE, NODE_PATH, LANG…) also live in each Dockerfile so
# they take effect at runtime; the values are identical on both sides.
#
# The two bases differ: Daytona = debian:bookworm, Cloudflare = ubuntu:22.04.
# Everything here installs cross-distro AND survives QEMU cross-build (an
# Apple-Silicon `wrangler deploy` builds the linux/amd64 image emulated): Node
# and chrome from official tarballs, pnpm via npm, Python 3.11 from native
# distro debs (deadsnakes PPA on ubuntu), and the apt packages whose names are
# identical on bookworm AND jammy (LibreOffice, poppler, pandoc, ffmpeg, Noto
# fonts, build tools). Nothing here relies on statically-built binaries that
# trip QEMU (uv's python-build-standalone did — hence apt, not uv).
set -eux

# Pinned versions — keep chrome in lockstep with @remotion/renderer
# (packages/builtin-tool-video-presentation/src/pipeline/renderer-version.ts).
NODE_VERSION="${NODE_VERSION:-22.19.0}"
PNPM_VERSION="${PNPM_VERSION:-10.19.0}"
CHROME_HEADLESS_SHELL_VERSION="${CHROME_HEADLESS_SHELL_VERSION:-149.0.7790.0}"
CHROME_HEADLESS_SHELL_SHA256="${CHROME_HEADLESS_SHELL_SHA256:-a3b011ab4c726e215cdeb623907a09cfb48f07054a7271fdda555ee2ae4f804d}"
REMOTION_RENDERER_VERSION="${REMOTION_RENDERER_VERSION:-4.0.468}"

export DEBIAN_FRONTEND=noninteractive
export PNPM_HOME="${PNPM_HOME:-/pnpm}"
export VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"
export SOURCEWEFT_REMOTION_BROWSER="${SOURCEWEFT_REMOTION_BROWSER:-/opt/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell}"
export SOURCEWEFT_PNPM_STORE="${SOURCEWEFT_PNPM_STORE:-/opt/sourceweft-pnpm-store}"
export PATH="${PNPM_HOME}:${VIRTUAL_ENV}/bin:${PATH}"

# ── System deps + locale ────────────────────────────────────────────────────
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    bash \
    jq \
    ripgrep \
    procps \
    gawk \
    sed \
    tar \
    unzip \
    zip \
    xz-utils \
    build-essential \
    pkg-config \
    fontconfig \
    fonts-liberation \
    locales \
    tzdata
sed -i -e '/^# en_US.UTF-8 UTF-8/s/^# //' /etc/locale.gen
locale-gen
update-locale LANG=en_US.UTF-8
rm -rf /var/lib/apt/lists/*

# ── Node.js (official tarball, arch-aware) ──────────────────────────────────
dpkgArch="$(dpkg --print-architecture)"
case "${dpkgArch##*-}" in
    amd64)  ARCH='x64' ;;
    arm64)  ARCH='arm64' ;;
    armhf)  ARCH='armv7l' ;;
    i386)   ARCH='x86' ;;
    *) echo "unsupported architecture: ${dpkgArch}"; exit 1 ;;
esac
curl -fsSL --compressed \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
    -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
rm /tmp/node.tar.xz
find /usr/local/include/node/openssl/archs -mindepth 1 -maxdepth 1 \
    ! -name "linux-${ARCH}" -exec rm -rf {} +
ln -sf /usr/local/bin/node /usr/local/bin/nodejs
node --version
npm --version

# ── pnpm (corepack activate, then pin as a real global) ─────────────────────
mkdir -p "${PNPM_HOME}"
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate
corepack disable
npm install -g "pnpm@${PNPM_VERSION}"
pnpm --version

# ── Trusted video render dependency cache ───────────────────────────────────
# Runtime validation still uses its generated frozen lockfile as authority.
# This image layer only prewarms the shared content-addressed pnpm store so a
# sandbox does not perform a cold registry install while it is serving a turn.
videoRenderCache=/tmp/sourceweft-video-render-cache
mkdir -p "${videoRenderCache}" "${SOURCEWEFT_PNPM_STORE}"
printf '%s\n' \
    '{' \
    '  "name": "sourceweft-video-render-cache",' \
    '  "private": true,' \
    '  "dependencies": {' \
    "    \"@remotion/bundler\": \"${REMOTION_RENDERER_VERSION}\"," \
    "    \"@remotion/renderer\": \"${REMOTION_RENDERER_VERSION}\"," \
    '    "@types/react": "18.3.18",' \
    '    "@types/react-dom": "18.3.5",' \
    '    "react": "18.3.1",' \
    '    "react-dom": "18.3.1",' \
    "    \"remotion\": \"${REMOTION_RENDERER_VERSION}\"," \
    '    "typescript": "5.9.2"' \
    '  }' \
    '}' > "${videoRenderCache}/package.json"
pnpm --dir "${videoRenderCache}" install \
    --ignore-scripts \
    --store-dir "${SOURCEWEFT_PNPM_STORE}"
rm -rf "${videoRenderCache}"
chmod -R a+rwX "${SOURCEWEFT_PNPM_STORE}"

# ── Python 3.11 + isolated venv with the document-processing packages ───────
# Native, distro-packaged CPython (dynamically linked) so it works both natively
# AND under QEMU cross-build (Apple-Silicon `wrangler deploy` builds linux/amd64
# emulated). uv's python-build-standalone binary segfaults under QEMU, so it is
# deliberately NOT used here. The two bases reach python3.11 differently:
#   • debian bookworm — python3.11 is in the default repos.
#   • ubuntu 22.04     — ships only 3.10; the deadsnakes PPA adds native 3.11.
# Both land on 3.11.x (patch may differ slightly by repo, acceptable for parity).
. /etc/os-release
if [ "${ID:-}" = "ubuntu" ]; then
    apt-get update
    apt-get install -y --no-install-recommends software-properties-common gnupg
    add-apt-repository -y ppa:deadsnakes/ppa
fi
apt-get update
apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-venv \
    python3.11-dev
rm -rf /var/lib/apt/lists/*
python3.11 -m venv "${VIRTUAL_ENV}"
"${VIRTUAL_ENV}/bin/pip" install --upgrade pip
"${VIRTUAL_ENV}/bin/pip" install \
    "pillow>=11" \
    "defusedxml>=0.7" \
    "markitdown[pptx]>=0.1" \
    "python-pptx>=1" \
    "python-docx>=1" \
    "openpyxl>=3" \
    "pandas>=2" \
    "numpy>=2" \
    "matplotlib>=3" \
    "plotly>=6" \
    "pyyaml>=6" \
    "toml>=0.10" \
    "python-dotenv>=1"
"${VIRTUAL_ENV}/bin/pip" cache purge

# ── LibreOffice (headless, only the components we use) ──────────────────────
apt-get update
apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-impress \
    libreoffice-calc
rm -rf /var/lib/apt/lists/*

# ── PDF / document utilities ────────────────────────────────────────────────
apt-get update
apt-get install -y --no-install-recommends \
    poppler-utils \
    pandoc \
    ffmpeg
rm -rf /var/lib/apt/lists/*

# ── Broad font coverage (Noto incl. CJK + emoji) ────────────────────────────
apt-get update
apt-get install -y --no-install-recommends \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji
fc-cache -fv
rm -rf /var/lib/apt/lists/*

# ── Global npm packages + Playwright Chromium ───────────────────────────────
# PLAYWRIGHT_BROWSERS_PATH: browsers must land at a world-readable fixed path,
# not the invoking root user's cache, so the non-root sandbox user can read them.
npm install -g \
    pptxgenjs \
    @marp-team/marp-cli \
    react \
    react-dom \
    react-icons \
    sharp \
    playwright
npx playwright install --with-deps chromium
chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"
npm cache clean --force

# ── Chrome Headless Shell (Remotion render browser, image rung) ─────────────
# Video pipeline render scripts read SOURCEWEFT_REMOTION_BROWSER and pass it to
# @remotion/renderer; without this bake Remotion downloads it per job at render
# time. linux64-only upstream; other arches degrade to the ladder's fetch rung.
if [ "${dpkgArch##*-}" = "amd64" ]; then
    curl -fsSL --retry 4 \
        "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
        -o /tmp/chrome-headless-shell.zip
    echo "${CHROME_HEADLESS_SHELL_SHA256}  /tmp/chrome-headless-shell.zip" | sha256sum -c -
    mkdir -p /opt/chrome-headless-shell
    unzip -q /tmp/chrome-headless-shell.zip -d /opt/chrome-headless-shell
    rm /tmp/chrome-headless-shell.zip
    chmod -R a+rX /opt/chrome-headless-shell
    chmod a+rx "${SOURCEWEFT_REMOTION_BROWSER}"
else
    echo "chrome-headless-shell: no linux64 build for ${dpkgArch}, skipping bake"
fi

# ── Shared runtime dirs (ownership is set per-provider in each Dockerfile) ───
# /skills is the platform skill-staging contract root (SOURCEWEFT_SKILLS_ROOT).
mkdir -p /workspace/input /workspace/work /workspace/output /skills "${PNPM_HOME}"

echo "SourceWeft sandbox base provisioning complete."
