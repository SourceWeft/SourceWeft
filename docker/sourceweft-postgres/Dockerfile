FROM postgres:17-bookworm

ARG SOURCEWEFT_POSTGRES_RELEASE=17
ARG PG_TEXTSEARCH_REF=023c3841b7d41fd3dbdbaa6f48ef3da46c9a362b
ARG PGVECTOR_VERSION=0.8.2
ARG AGE_VERSION=1.7.0
ARG AGE_DOWNLOAD_URL=https://downloads.apache.org/age/PG17/${AGE_VERSION}/apache-age-${AGE_VERSION}-src.tar.gz
ARG PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config

LABEL org.opencontainers.image.title="sourceweft-postgres"
LABEL org.opencontainers.image.description="PostgreSQL 17 with pg_textsearch, pgvector, and Apache AGE"
LABEL org.opencontainers.image.version="${SOURCEWEFT_POSTGRES_RELEASE}"
LABEL org.sourceweft.pg_textsearch.ref="${PG_TEXTSEARCH_REF}"
LABEL org.sourceweft.pgvector.version="${PGVECTOR_VERSION}"
LABEL org.sourceweft.age.version="${AGE_VERSION}"

USER root

RUN set -eux; \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bison \
    build-essential \
    ca-certificates \
    curl \
    flex \
    libreadline-dev \
    postgresql-server-dev-17 \
    zlib1g-dev \
  && mkdir -p /tmp/pg_textsearch-src \
  && curl -fsSL "https://github.com/timescale/pg_textsearch/archive/${PG_TEXTSEARCH_REF}.tar.gz" -o /tmp/pg_textsearch.tar.gz \
  && tar -xzf /tmp/pg_textsearch.tar.gz -C /tmp/pg_textsearch-src --strip-components=1 \
  && make -C /tmp/pg_textsearch-src PG_CONFIG="${PG_CONFIG}" install \
  && mkdir -p /tmp/pgvector-src \
  && curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" -o /tmp/pgvector.tar.gz \
  && tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector-src --strip-components=1 \
  && make -C /tmp/pgvector-src PG_CONFIG="${PG_CONFIG}" install \
  && mkdir -p /tmp/age-src \
  && curl -fsSL "${AGE_DOWNLOAD_URL}" -o /tmp/age-src/apache-age.tar.gz \
  && tar -xzf /tmp/age-src/apache-age.tar.gz -C /tmp/age-src --strip-components=1 \
  && make -C /tmp/age-src PG_CONFIG="${PG_CONFIG}" install \
  && mkdir -p /usr/lib/postgresql/17/lib/plugins /docker-entrypoint-initdb.d \
  && ln -sf /usr/lib/postgresql/17/lib/age.so /usr/lib/postgresql/17/lib/plugins/age.so \
  && rm -rf /tmp/pg_textsearch-src /tmp/pg_textsearch.tar.gz /tmp/pgvector-src /tmp/pgvector.tar.gz /tmp/age-src \
  && apt-get purge -y --auto-remove \
    bison \
    build-essential \
    curl \
    flex \
    libreadline-dev \
    postgresql-server-dev-17 \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

COPY docker/sourceweft-postgres/initdb/001_extensions.sql /docker-entrypoint-initdb.d/001_extensions.sql

CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
