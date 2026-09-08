# Model catalog, retrieval and request failures

## Model readiness errors

A GLOBAL request with no eligible ready route target fails with gateway code
`CONFIGURATION`, not `AUTH`. The API, stream and durable preparation paths map
it to `MODEL_CONFIGURATION_ERROR` (503) with a safe message asking the operator
to check Provider and route configuration. This error is not retryable and does
not activate or select another undeclared Provider. Existing authentication
errors, including upstream 401/403 and missing BYOK credentials, retain their
authentication classification.

## Catalog publication

When the normalized registry is needed, LiteLLM and models.dev are both required
sources. Their existing precedence is retained: LiteLLM, then models.dev, then
repository/operator overrides. HTTP errors, JSON failures and invalid entry
objects reject the refresh. A valid empty object remains a successful empty
source. Overrides are prepared before publication too; an invalid configured
override file cannot replace a prior snapshot with an empty override map.

All registry indexes are replaced together after preparation succeeds. A failed
refresh keeps the last complete in-memory snapshot; an initial failure leaves
the registry unready. Periodic refresh starts doing network work only after a
caller has needed and successfully loaded the registry.

Configuration sync loads only the catalogs it needs. Disabled or credential-
incomplete global Providers do not trigger discovery. Static configurations with
explicit manual prices and disabled discovery need no remote registry. A
self-describing OpenRouter catalog with inline prices can use its own data;
dynamic models needing automatic pricing require the registry to load before
database activation, just as static automatic prices do.

Failure of a required registry or Provider catalog aborts configuration sync
before database changes, preserving the previous active version and its routes.
A valid empty Provider catalog retires its old dynamic entries, subject to
embedding identity protection for existing vectors.

Background price updates use the same configuration lock order as config sync.
They verify the active version and reread the profile under a row lock before
merging their owned fields. An old task cannot overwrite a new embedding
definition or a newly pinned manual price. Catalog network calls stay outside
these short database transactions.

## Retrieval failures

The backend BM25 repository propagates SQL errors. A successful search with no
matches still returns an empty result. The standard application flow fails when
BM25 fails, including the anchor-source branch.

An internal caller can explicitly allow a hybrid search to continue using its
vector channel:

```ts
runRetrieval(
  {
    ...input,
    tuning: { ...input.tuning, bm25FailurePolicy: "allow_vector" },
  },
  dependencies,
);
```

The default policy is `"fail"`. A `bm25_only` strategy always fails if BM25 fails,
because it has no other search channel. An allowed hybrid degradation is returned
in `result.degradations` and recorded in the existing retrieval audit metadata,
with distinct main/anchor stages. This change adds no deployment environment
variable or automatic Provider/data-source selection.

## Model request limits

Effective options use request values first, then the selected Provider's values,
then gateway defaults. `maxRetries: 0` is preserved. Each target attempt gets a
fresh timeout budget, combined with caller cancellation. All retries for that
attempt share its timeout; moving to a declared next target starts that target's
budget. Cancellation stops retries and Provider failover.

Chat, embedding, rerank, image, ASR and TTS requests now honor their declared
options. Raw transports previously ignored `maxRetries`; they now execute the
configured retry budget using the SDK's existing status/quota error rules.
Injected rerank implementations are guarded for timeout/cancellation without
adding a second retry layer. Network policy refusals are never retryable.

LangChain calls obtain fresh execution options per invocation, including
`invoke`, `stream`, SDK `batch`, and the supported `withConfig`, `bindTools` and
`withStructuredOutput` combinations. SDK configuration/callback merging is
preserved; configuring a model no longer bypasses the gateway's timeout guard.
The existing invoke streaming behavior is retained.

Stream closure, partial-usage settlement, tool-message grouping and durable
terminal events now follow [stream and run lifecycle](stream-run-lifecycle.md).
Unauthenticated System OpenAI-compatible transport is supported through the
explicit configuration described in [local LLM networking](llm-network.md).
AnyDoc is the sole parser for its supported document formats. Retired
`DOCUMENT_PARSE_PROVIDER` selections (including `langchain` and `pdf2markdown`)
and non-explicit `DOCUMENT_PARSE_STRATEGY` values fail startup with migration
instructions. Remove these environment variables; an existing `anydoc`/`explicit`
declaration is accepted without exposing a runtime selector. PDF2Markdown remains
available only for explicitly enabled OCR and existing pending-task resumes.
Only native `needsOcr` enters that OCR branch. Other failures propagate without
switching parsers or providers.

## Optional default skills

Enabling a skill by default expands the tools available to ordinary chat. It
does not require every optional model or sandbox service to be configured. A
missing optional image model is recorded as `image_model_unavailable` and the
turn's effective image-tool selection is disabled before binding. A tool that
declares `requirements.sandbox:true` is unavailable when that turn has no
sandbox; the host records the reason and consistently disables its selection,
permission and binding. Required-tool validation remains strict for available
tools.

An explicitly invoked skill, including an `invokedSkillIds` chip for a default
skill, keeps its declared output requirement. `/image` requires an image model;
`/ppt` requires its sandbox tools and fails with `SANDBOX_RUNTIME_UNAVAILABLE`
when they are unavailable. Image generation used as a PPT helper stays optional.
Database or configuration-read errors still propagate; no model is substituted.
