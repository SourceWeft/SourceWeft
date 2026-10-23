# Embedding index safety

Changing an embedding model can make stored vectors incompatible even when the
new model has the same output dimension. Configuration sync now refuses such
changes while indexed vectors exist, before changing the active version.

Protected identity is the profile, the canonical model name (the last `/`
segment of the target model, ignoring case) and the requested dimensions. The
same model served by two Providers is one vector space, so an embedding profile
may list several same-model `targets` for failover: which Provider, endpoint,
routing constraint or header produced a vector is not part of the identity, and
adding, removing or reordering same-model targets keeps the recorded definition
and its revision. Two different models behind one alias are refused when the
configuration loads. API keys, prices, timeouts and retry counts are not vector
identity. Provider activation and key removal or rotation continue to take
effect independently.

Definitions recorded by earlier releases (`version: 1`, pinned to one Provider
and endpoint) are read as the current shape with the same revision, both on the
profile row and in `documentMetadata.embeddingIdentity`; a sync neither assigns
a new revision nor relabels documents for that upgrade, and vector retrieval
compares the identity fields rather than the recorded JSON, so documents stamped
with the earlier shape remain searchable.

With indexed vectors, sync rejects incompatible definitions, removing or disabling
an indexed profile, disabling its vectors, and switching the default profile.
An empty index permits a new definition or default. Rejection preserves the
previous active version, profiles, routes and vectors. There is no automatic
vector deletion, model substitution or full-index rebuild in this change.

## In-flight operations

Indexing and retrieval prepare their embedding profile and gateway configuration
in the same short database transaction. The model call uses that configuration
snapshot and the explicit profile alias. It verifies that the model the gateway
actually used is the alias's model (any of its same-model targets) and that the
dimensions match.

Before committing vectors or running vector-distance SQL, the database checks
that the identity is still current. Config sync uses the existing exclusive
advisory lock; preparation, index writes and vector queries use its shared form.
No database lock is retained during a model HTTP request. If the first vector
write commits first, an incompatible sync fails. If an empty-index sync commits
first, the old in-flight result fails before deleting or inserting vectors.

Profiles with unspecified dimensions also coordinate on the profile row:
writers take an update lock and queries take a share lock. The first writes
cannot introduce different dimensions across sources, and a dimension check
cannot race a first write before the distance query. Lock order is configuration,
then profile when needed, then source for writes.

`profile.configJson.embeddingDefinition` describes the current configuration.
Only newly guarded vector writes record their generation identity in
`documentMetadata.embeddingIdentity`. Existing documents are not relabeled by a
sync. Historical vectors without that metadata retain their existing read path,
but their original model provenance remains unverified. A known mismatched
identity or dimension fails explicitly. Unknown historical provenance requires
separate validation/rebuilding; it is not silently certified by this change.

## Usage observation

OpenAI-compatible and Azure embeddings record token usage from the SDK's
already-parsed response. The SDK retains its batching, retries and vector
decoding. Observation does not clone the response body or retain vector arrays.
Only successfully returned batches contribute usage; a request that fails or
is cancelled retains the known partial usage with an incomplete diagnostic.
Responses arriving after termination cannot change that observation.

Missing usage remains unknown (`NULL` in generation records), rather than zero
or an estimate based on text length. The native Gemini embedding SDK does not
expose equivalent usage in this path and remains unknown. Known usage can support
the existing price-book estimate; it is not a Provider cost receipt.

Batch request IDs are saved in `normalizationJson.providerRequestIds`. The scalar
`providerRequestId` represents a single successful batch only. IDs are bounded
to 256 UTF-8 bytes each and 16 KiB of ID content per call; omitted IDs have an
explicit diagnostic/count. Vector response capacity is unchanged.

This observation change does not introduce user charges: document ingestion
keeps its page-based policy, and retrieval embeddings remain covered.

## Rollout and verification

No schema migration is added. Synchronize the model configuration with the new
scheduler before starting new indexing/vector-query traffic, so profiles have a
recorded definition. All index-writing instances must use the new protocol;
older instances do not participate in its locks or identity checks. Automated
rebuilding and index-version migration remain a separate project.

The M04/M05 concurrency tests create temporary independent databases on the
existing PostgreSQL service, apply the repository's extension initialization and
full backend migrations, and drop their own databases after closing connections.
They require database creation permission and do not write application tables
in the original database.

The previous Node 20 migration failure is resolved by the new default runtime,
Node 22.23.2. Complete backend migrations and tests pass on both Node 22.23.2 and
24.18.0. The installed auth CLI requires Node >=22.12, and PDF.js requires at
least 22.13 on the Node 22 line. No parser downgrade, polyfill or migration bypass
was added. See [runtime policy](node-runtime.md) for support and CI coverage.
