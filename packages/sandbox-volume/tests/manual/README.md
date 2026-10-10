# Manual 2 GiB service probe

`gib-service.probe.mts` is explicitly opt-in and excluded from the default `test`
command. It uses production TypeScript services, a real isolated PostgreSQL
server, and an external **local disk object fixture**, not S3/R2. It tests
checkpoint-confirmed bytes, not durability of every POSIX write. Neither this
probe nor its result establishes production readiness. Destruction in this
probe means client files/process state, not host power loss. File and parent
directory fsync tighten the fixture's write boundary, but the PostgreSQL data
volume is tmpfs: this is **not** an acceptance test for host power failure.

The fixed `swvol-228-2gib-v1` seed produces 2 GiB of actual AES-CTR pseudorandom
bytes: one 1 GiB file plus 4096 files of 256 KiB. The 8192 chunks use real BLAKE3
and zstd in 128 packs. An independent SHA256 file ledger is generated from the
original byte stream. The explicit test dependency `@noble/hashes@2.3.0` uses the
same BLAKE3 implementation/version as the initial isolated experiment; it is
not a runtime dependency.

Requires Node with zstd support, installed workspace dependencies, and at least
8 GiB free temporary disk space. The probe intentionally accepts only the
`volume_test` test database on `127.0.0.1:55429`; do not change it to a business
DB. Example isolated server (the image is pinned to the experiment/CI image):

```sh
docker run -d --name swvol-pg-gb-228 --platform linux/amd64 \
  -e POSTGRES_USER=volume_test -e POSTGRES_PASSWORD=volume_test \
  -e POSTGRES_DB=volume_test -p 127.0.0.1:55429:5432 \
  --tmpfs /var/lib/postgresql/data \
  postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3
```

From `packages/sandbox-volume`, choose a new evidence directory (do not reuse
an existing run). Keep each stage a separate process:

```sh
export PROBE_ROOT=/private/tmp/swvol-gb-my-run # Linux: /tmp/swvol-gb-my-run
export SANDBOX_VOLUME_TEST_DATABASE_URL=postgres://volume_test:volume_test@127.0.0.1:55429/volume_test
mkdir -p "$PROBE_ROOT"
pnpm exec tsx tests/manual/gib-service.probe.mts generate > "$PROBE_ROOT/generate.log" 2>&1
pnpm exec tsx tests/manual/gib-service.probe.mts restore > "$PROBE_ROOT/restore.log" 2>&1
pnpm exec tsx tests/manual/gib-service.probe.mts mutate > "$PROBE_ROOT/mutate.log" 2>&1
pnpm exec tsx tests/manual/gib-service.probe.mts metadata > "$PROBE_ROOT/metadata.log" 2>&1
```

Run the next stage only if the preceding command succeeded. `generate` obtains
and verifies a receipt before deleting all client files. `restore` reconstructs
2 GiB from PostgreSQL and the object fixture, checking every chunk's BLAKE3 and
every file's SHA256/size. `mutate` changes the large file, removes a 64-file
directory, checks current and historical bytes, rolls back, runs real GC on a
registered orphan pack, then rechecks restored and historical bytes. It must
retain all referenced historical packs. `metadata` also checks paths, kinds,
modes and mtimes at all three sequence numbers. Logs include actual bytes,
counts, timings and process resource usage; step counts are not data volume.

Evidence and the random test schema are retained on success **and** failure.
Read `meta.json` to identify the schema. Export `pg_dump -Fc` to the host and
validate it with `pg_restore --list` and a complete decode before stopping a
container backed by tmpfs. Keep the dump, logs and independent oracle together;
then explicitly remove only this test container/schema and temporary data.
The separate experimental mutation-journal prototype is not part of this
production service probe or protocol.
