# syntax=docker/dockerfile:1

# ── SourceWeft unified sandbox image (Daytona provider) ─────────────────────
# Agent execution, PPTX/DOCX/PDF document processing, browser automation.
#
# The base tooling (Node, pnpm, Python venv, LibreOffice, poppler/pandoc/ffmpeg,
# Noto fonts, global npm + Playwright Chromium, chrome-headless-shell) is
# installed by docker/sourceweft-sandbox/install-base.sh — the SINGLE source of
# truth shared with the Cloudflare sandbox image
# (packages/sandbox-provider-cloudflare/bridge/Dockerfile) so the two providers
# present an identical base environment and cannot drift.
#
# This Dockerfile owns only what is provider-specific: the debian base, the ENV
# declarations, and the non-root `sourceweft` user + workspace ownership.

FROM debian:bookworm-slim

# Locale / timezone (locale is generated inside install-base.sh).
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    TZ=UTC

# Fixed tool paths — must match install-base.sh and the Cloudflare image.
ENV NODE_VERSION=22.19.0
ENV PNPM_HOME=/pnpm
ENV VIRTUAL_ENV=/opt/venv
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ENV SOURCEWEFT_REMOTION_BROWSER=/opt/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell
ENV SOURCEWEFT_PNPM_STORE=/opt/sourceweft-pnpm-store
ENV SOURCEWEFT_HTML_RUNTIME=/opt/sourceweft-html
ENV SOURCEWEFT_HTML_FONTS=/opt/sourceweft-html-fonts
ENV NODE_PATH=/usr/local/lib/node_modules
ENV PATH="${PNPM_HOME}:${VIRTUAL_ENV}/bin:${PATH}"

# ── Base provisioning (shared with the Cloudflare sandbox image) ────────────
COPY html-runtime /opt/sourceweft-html
COPY install-base.sh /tmp/install-base.sh
RUN chmod +x /tmp/install-base.sh && /tmp/install-base.sh && rm /tmp/install-base.sh

# ── Non-root user + workspace ownership ─────────────────────────────────────
# /skills is the platform skill-staging contract root; the non-root user cannot
# create root-level dirs at runtime, so it must exist and be writable here.
RUN groupadd -r sourceweft -g 1000 \
    && useradd -r -g sourceweft -u 1000 -m -d /home/sourceweft sourceweft \
    && mkdir -p /tmp \
    && chown -R sourceweft:sourceweft /workspace /skills /tmp "${PNPM_HOME}"

WORKDIR /workspace
USER sourceweft

# ── Smoke tests (run as the non-root user to catch permission issues) ───────
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

LABEL org.opencontainers.image.source="https://github.com/SourceWeft/SourceWeft"
LABEL org.opencontainers.image.description="SourceWeft unified sandbox image — agent execution, document processing, browser automation"
