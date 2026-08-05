# syntax=docker/dockerfile:1

# ── Base Sandbox Image ──────────────────────────────────────────────────
# Single default image covering all sandbox workloads:
# agent execution, PPTX/DOCX/PDF document processing, browser automation.
#
# Architecture decisions (backed by the lobehubbot/python-node pattern):
#   • debian:bookworm-slim — Debian 12 stable, no Trixie backport roulette.
#     LobeHub uses this same base; it ships Python 3.11 natively.
#   • Node.js from the official nodejs.org tarball (same as LobeHub).
#     Avoids NodeSource apt-repo routing across Debian releases.
#   • Python packages in an isolated venv at /opt/venv (same as LobeHub).
#     No --break-system-packages required; PATH points to the venv.
#   • SourceWeft *extends* this foundation with the full document-processing
#     stack: LibreOffice headless, poppler, pandoc, ffmpeg, Noto CJK fonts,
#     Playwright Chromium, pptxgenjs, marp-cli, and Python data-science libs.

FROM debian:bookworm-slim

# ── System deps ─────────────────────────────────────────────────────────
# Non-root user, locale, timezone, and ca-certs go first so they're cached
# across package-list changes.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        bash \
        jq \
        unzip \
        zip \
        build-essential \
        pkg-config \
        fontconfig \
        fonts-liberation \
        locales \
        tzdata \
    ; \
    sed -i -e '/^# en_US.UTF-8 UTF-8/s/^# //' /etc/locale.gen; \
    locale-gen; \
    update-locale LANG=en_US.UTF-8; \
    rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    TZ=UTC

# ── Node.js 22 LTS ──────────────────────────────────────────────────────
# Install directly from Node.js official tarballs — same approach as
# lobehubbot/python-node (they install Node 20 the same way).
ENV NODE_VERSION=22.19.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    ARCH=; \
    dpkgArch="$(dpkg --print-architecture)"; \
    case "${dpkgArch##*-}" in \
        amd64)  ARCH='x64' ;; \
        arm64)  ARCH='arm64' ;; \
        armhf)  ARCH='armv7l' ;; \
        i386)   ARCH='x86' ;; \
        *) echo "unsupported architecture: ${dpkgArch}"; exit 1 ;; \
    esac; \
    curl -fsSL --compressed \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
        -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    find /usr/local/include/node/openssl/archs -mindepth 1 -maxdepth 1 \
        ! -name "linux-${ARCH}" -exec rm -rf {} +; \
    ln -s /usr/local/bin/node /usr/local/bin/nodejs; \
    node --version; \
    npm --version

# pnpm via corepack (version pinned for reproducibility)
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@10.19.0 --activate

# ── Python 3.11 ─────────────────────────────────────────────────────────
# Bookworm ships Python 3.11.2 natively.  venv isolates pip packages from
# the system Python — same pattern as lobehubbot/python-node (/opt/venv).
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3-pip \
    ; \
    rm -rf /var/lib/apt/lists/*; \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1; \
    python3.11 -m venv "${VIRTUAL_ENV}"

# ── Python packages (venv) ──────────────────────────────────────────────
# Preinstalled so skill scripts run without a pip install step.
# Pinned to major versions for reproducibility; lockfiles would be overkill
# for a sandbox image — rebuild on schedule handles drift.
RUN set -eux; \
    pip3 install \
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
        "python-dotenv>=1" \
    ; \
    pip3 cache purge

# ── LibreOffice (headless) ──────────────────────────────────────────────
# Only the components we actually use.  Skipping base, math, and the
# full GUI saves ~200 MB vs the full libreoffice metapackage.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libreoffice-writer \
        libreoffice-impress \
        libreoffice-calc \
    ; \
    rm -rf /var/lib/apt/lists/*

# ── PDF / document utilities ────────────────────────────────────────────
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        poppler-utils \
        pandoc \
        ffmpeg \
    ; \
    rm -rf /var/lib/apt/lists/*

# ── Broad font coverage ─────────────────────────────────────────────────
# Noto CJK is ~120 MB compressed — large, but required for Chinese/Japanese/
# Korean slide rendering.  If multi-language PPTX is not a product priority
# in the future, this is the first candidate to move to an optional layer.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        fonts-noto-core \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
    ; \
    fc-cache -fv; \
    rm -rf /var/lib/apt/lists/*

# ── Global npm packages ─────────────────────────────────────────────────
# pptxgenjs + react-icons + sharp form the primary "create from scratch"
# path.  playwright gives us Chromium for HTML→PPT/PDF/screenshots.
# @marp-team/marp-cli offers a fast Markdown→PPT fallback.
#
# PLAYWRIGHT_BROWSERS_PATH: installed browsers must live at a world-readable
# fixed path.  Without it they land in /root/.cache/ms-playwright — invisible
# to the non-root sandbox user every command actually runs as.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN set -eux; \
    npm install -g \
        pptxgenjs \
        @marp-team/marp-cli \
        react \
        react-dom \
        react-icons \
        sharp \
        playwright \
    ; \
    npx playwright install --with-deps chromium; \
    chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"; \
    npm cache clean --force

# ── Chrome Headless Shell (Remotion render browser) ────────────────────
# Runtime-asset image rung (docs/architecture/sandbox-runtime-assets.md):
# the video pipeline's render scripts read SOURCEWEFT_REMOTION_BROWSER and
# pass it to @remotion/renderer as browserExecutable — Remotion never probes
# system browsers (the Playwright Chromium above is invisible to it) and
# would otherwise download this exact build from remotion.media at render
# time, per job, per sandbox.  Version and sha256 are pinned in lockstep
# with @remotion/renderer (see packages/builtin-tool-video-presentation/
# src/pipeline/renderer-version.ts — update both together).
# linux64-only upstream; skipped on other arches (the ladder's platform
# cache then serves x64 sandboxes and other arches degrade explicitly).
ENV SOURCEWEFT_REMOTION_BROWSER=/opt/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell
RUN set -eux; \
    dpkgArch="$(dpkg --print-architecture)"; \
    if [ "${dpkgArch##*-}" = "amd64" ]; then \
        CHROME_HEADLESS_SHELL_VERSION=149.0.7790.0; \
        CHROME_HEADLESS_SHELL_SHA256=a3b011ab4c726e215cdeb623907a09cfb48f07054a7271fdda555ee2ae4f804d; \
        curl -fsSL --retry 4 \
            "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
            -o /tmp/chrome-headless-shell.zip; \
        echo "${CHROME_HEADLESS_SHELL_SHA256}  /tmp/chrome-headless-shell.zip" | sha256sum -c -; \
        mkdir -p /opt/chrome-headless-shell; \
        unzip -q /tmp/chrome-headless-shell.zip -d /opt/chrome-headless-shell; \
        rm /tmp/chrome-headless-shell.zip; \
        chmod -R a+rX /opt/chrome-headless-shell; \
        chmod a+rx "${SOURCEWEFT_REMOTION_BROWSER}"; \
    else \
        echo "chrome-headless-shell: no linux64 build for ${dpkgArch}, skipping bake"; \
    fi

# Corepack keeps package manager downloads in a per-user cache. Install pnpm
# as a real global executable so the sandbox user gets the pinned version.
RUN set -eux; \
    corepack disable; \
    npm install -g pnpm@10.19.0; \
    pnpm --version; \
    npm cache clean --force

# Make globally installed packages resolvable from sandbox scripts.
ENV NODE_PATH=/usr/local/lib/node_modules

# ── Non-root user ───────────────────────────────────────────────────────
RUN groupadd -r sourceweft -g 1000 \
    && useradd -r -g sourceweft -u 1000 -m -d /home/sourceweft sourceweft

# Working directory matches SourceWeft sandbox runtime expectation
# (builtin-tool-sandbox SANDBOX_WORKSPACE_ROOT).
# /skills is the platform skill-staging contract root (SOURCEWEFT_SKILLS_ROOT,
# docs/architecture/sandbox-skill-staging.md): the runtime stages activated
# skill bundles under /skills/<name>/ at provision time. It must exist and be
# writable by the sandbox user — the non-root user cannot create root-level
# directories at runtime, so a missing /skills degrades skill-script execution.
WORKDIR /workspace
RUN mkdir -p /workspace/input /workspace/work /workspace/output /skills /tmp "${PNPM_HOME}" \
    && chown -R sourceweft:sourceweft /workspace /skills /tmp "${PNPM_HOME}"

USER sourceweft

# ── Smoke tests ─────────────────────────────────────────────────────────
# Quick sanity checks that fail the build if a core tool is missing.
# These run as the non-root user to catch permission issues early.
RUN set -eux; \
    node --version; \
    npm --version; \
    pnpm --version; \
    python3 --version; \
    python3 -c "import pptx; print('python-pptx', pptx.__version__)"; \
    python3 -c "from defusedxml import minidom; print('defusedxml ok')"; \
    python3 -c "from PIL import Image; print('Pillow ok')"; \
    soffice --version; \
    pandoc --version; \
    pdftoppm -v; \
    node -e "require('pptxgenjs'); console.log('pptxgenjs ok')"; \
    npx playwright --version; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        "${SOURCEWEFT_REMOTION_BROWSER}" --version; \
        test -r "${PLAYWRIGHT_BROWSERS_PATH}"; \
    fi; \
    echo "All smoke tests passed."

# ── Labels ──────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.source="https://github.com/SourceWeft/SourceWeft"
LABEL org.opencontainers.image.description="SourceWeft unified sandbox image — agent execution, document processing, browser automation"
