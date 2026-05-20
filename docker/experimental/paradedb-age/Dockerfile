FROM paradedb/paradedb:latest-pg17

ARG AGE_VERSION=1.7.0
ARG AGE_DOWNLOAD_URL=https://downloads.apache.org/age/PG17/${AGE_VERSION}/apache-age-${AGE_VERSION}-src.tar.gz
ARG PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bison \
    build-essential \
    ca-certificates \
    curl \
    flex \
    libreadline-dev \
    postgresql-server-dev-17 \
    zlib1g-dev \
  && mkdir -p /tmp/age-src \
  && curl -fsSL "${AGE_DOWNLOAD_URL}" -o /tmp/age-src/apache-age.tar.gz \
  && tar -xzf /tmp/age-src/apache-age.tar.gz -C /tmp/age-src --strip-components=1 \
  && make -C /tmp/age-src PG_CONFIG="${PG_CONFIG}" install \
  && mkdir -p /usr/lib/postgresql/17/lib/plugins \
  && ln -sf /usr/lib/postgresql/17/lib/age.so /usr/lib/postgresql/17/lib/plugins/age.so \
  && rm -rf /tmp/age-src \
  && apt-get purge -y --auto-remove \
    bison \
    build-essential \
    curl \
    flex \
    libreadline-dev \
    postgresql-server-dev-17 \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

USER postgres
