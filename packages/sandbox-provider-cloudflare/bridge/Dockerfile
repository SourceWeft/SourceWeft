# syntax=docker/dockerfile:1

# ── SourceWeft sandbox image (Cloudflare provider) ──────────────────────────
# Version-controlled custom image for the Cloudflare Sandbox Bridge. The stock
# `cloudflare/sandbox` base ships only the control-plane server (port 3000) and
# a bare Debian userland — no Node/pnpm/Python/document stack — so SourceWeft
# workloads (video pipeline `pnpm install`, PPTX/DOCX processing) fail on it.
#
# deploy.sh copies this file AND docker/sourceweft-sandbox/install-base.sh into
# the git-ignored scaffold and builds from there (wrangler.jsonc image:
# "./Dockerfile"). The base tooling comes from that SAME install-base.sh the
# Daytona image uses, so both providers present an identical base environment.
#
# Provider-specific here: the cloudflare base + its control plane, the fusermount
# fix, and the non-root `sandbox` user + workspace ownership.

FROM docker.io/cloudflare/sandbox:0.12.7

# Locale / timezone (locale is generated inside install-base.sh).
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    TZ=UTC

# Fixed tool paths — must match install-base.sh and the Daytona image.
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

# fusermount requires /etc/mtab to find active mounts; the base image omits it,
# causing `fusermount -u` to fail silently during bucket unmount.
RUN ln -sf /proc/mounts /etc/mtab

# ── Base provisioning (shared with the Daytona sandbox image) ───────────────
COPY html-runtime /opt/sourceweft-html
COPY install-base.sh /tmp/install-base.sh
RUN chmod +x /tmp/install-base.sh && /tmp/install-base.sh && rm /tmp/install-base.sh

# ── Non-root user + workspace ownership ─────────────────────────────────────
# Commands executed via sandbox.exec() run as this user (defense-in-depth).
# /skills is the platform skill-staging contract root and must be writable here.
RUN useradd -m -s /bin/bash -d /home/sandbox sandbox 2>/dev/null || true; \
    mkdir -p /workspace /skills "${PNPM_HOME}"; \
    chown -R sandbox:sandbox /workspace /skills "${PNPM_HOME}"; \
    chmod 700 /root || true

WORKDIR /workspace
USER sandbox

# ── Smoke tests (run as the non-root user to catch permission issues) ───────
RUN set -eux; \
    node --version; \
    npm --version; \
    pnpm --version; \
    python3 --version; \
    python3 -c "import pptx; print('python-pptx', pptx.__version__)"; \
    soffice --version; \
    pandoc --version; \
    node -e "require('pptxgenjs'); console.log('pptxgenjs ok')"; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        "${SOURCEWEFT_REMOTION_BROWSER}" --version; \
    fi; \
    echo "All smoke tests passed."
