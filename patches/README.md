# Dependency patches

## OpenAI-compatible local services

`openai@6.49.0` adds two default-off options, covering source, ESM, CommonJS and
their declarations:

- `allowUnauthenticated` permits construction and requests without authentication
  headers. SourceWeft derives it only for a GLOBAL System `openai-compatible`
  Provider without a declared or actual global credential. The adapter supplies
  `apiKey: null`, `adminAPIKey: null`, `organization: null` and `project: null`
  to prevent both LangChain and the SDK from using ambient credentials. It does
  not activate a Provider and is never inherited by BYOK.
- `ignoreEnvironmentHeaders` prevents implicit `OPENAI_CUSTOM_HEADERS` merging.
  The OpenAI SDK adapters set it for authenticated requests too: otherwise an
  ambient Authorization header could override the BYOK user's key. Explicit
  Provider headers retain their existing behavior. No-auth also suppresses
  ambient headers independently.

LangChain drops null header values, so constructor-only support plus null auth
headers is insufficient. The explicit SDK flag controls header validation too.
Default SDK credential checks remain unchanged. The patch does not replace
transport, model conversion, retries or streaming, or create a dummy API key.

The root override pins the already-used version, and pnpm applies this patch
to its peer variants. Review the patch before upgrading OpenAI. Use:

```sh
pnpm patch openai@6.49.0 --edit-dir /tmp/openai-sdk-edit
pnpm patch-commit /tmp/openai-sdk-edit --patches-dir patches
pnpm install --frozen-lockfile
```

Run the full model-gateway tests, including `openai-sdk-options.test.ts` for ESM
and CommonJS, `unauthenticated-system.test.ts` for actual adapters, and backend
`local-llm-no-auth.database.test.ts` for config sync, real HTTP, database credentials and
GLOBAL/BYOK isolation. Check Docker prune includes the patch and frozen lockfile.

## Gemini transport

These two patches restore native Gemini chat and embeddings through the host's
controlled fetch. They keep the existing Gemini protocol and LangChain response
conversion. They do not install a global fetch override or switch protocols.

- `@google/generative-ai@0.24.1`: expose fetch in model RequestOptions, retain
  wrapped error causes, propagate already-aborted signals, and prevent the
  unused aggregate streaming promise from causing an unhandled rejection.
  The returned aggregate promise and the primary stream still reject on error.
- `@langchain/google-genai@2.2.0`: pass fetch to chat and embedding requests,
  retain it when using cached content, pass cancellation signals, and throw a
  failed embedding batch instead of substituting empty vectors.

ESM, CommonJS, and their declarations are patched. Both versions are pinned;
these patches must be reviewed before either dependency changes. The SDK's
separate file/cache management `@google/generative-ai/server` entry is outside
this integration and is not patched.

Use the standard pnpm workflow to edit a patch:

```sh
pnpm patch @google/generative-ai@0.24.1 --edit-dir /tmp/gemini-sdk-edit
pnpm patch-commit /tmp/gemini-sdk-edit --patches-dir patches
pnpm install --no-frozen-lockfile --ignore-scripts
pnpm install --frozen-lockfile --ignore-scripts
```

Use the equivalent command for `@langchain/google-genai@2.2.0`. `pnpm patch`
applies the existing patch to a clean package; do not modify the installed
`node_modules` directly. After changes, run the model-gateway tests and backend
`src/shared/model-gateway/gemini-network.test.ts` against a local HTTP server.
The tests include native chat, streaming, tools/history, schema, embeddings,
credential isolation, policy refusal, ordinary retry behavior, and cancellation.

## Streamdown streaming state

`streamdown@2.5.0` replaces the parsed-block `useEffect`/`setState` mirror with
`useDeferredValue`, retaining synchronous blocks for static and animated output.
This prevents React's nested-update cascade during long streaming replies.
The ESM chunk is the published runtime for both Web and UI consumers; pnpm's
patch hash in the lockfile ensures CI installs the same implementation.

The implementation follows [upstream PR #530](https://github.com/vercel/streamdown/pull/530)
at `3be0f504afae7e2f77bd6b6da84519618bcd2b91`, which was still open on 2026-09-08.
Review/remove this patch when adopting an upstream release containing the fix.
`long-reply-rendering.test.tsx` exercises the real renderer and scheduler with
long growing Markdown in both streaming modes; it reproduces the cascade on
the unpatched package. Do not wrap its frame loop in `act()`, which drains
each update and hides this scheduling failure. Also verify a live long chat
through publication, final reply, reload, and artifact download.

## LangChain model middleware Command collection

`langchain@1.5.10` deduplicates the same `Command` object in the model
middleware response collector, in both ESM and CommonJS. Its inner-handler
normalization already uses this identity check; the middleware-validation
layer must apply the same rule when no new AI message has been generated.

Without the patch, a checkpoint-only preparation Command passing through
nested middleware can collect the same native summarization Command several
times. This writes `_summarizationEvent` repeatedly in one graph step and fails
its native LastValue channel before the next Provider request. Real v3 report
streaming reproduced this failure; it is not a Provider/tool-argument error.

Only repeated object identity is deduplicated. Distinct Commands and genuine
conflicting LastValue writes retain their original behavior. No model,
Provider, transport, compression policy, retry policy or dependency version is
changed. Review/remove this patch when upgrading LangChain to a release with
the equivalent collector fix.

Use the existing patch workflow:

```sh
pnpm patch langchain@1.5.10 --edit-dir /tmp/langchain-command-edit
pnpm patch-commit /tmp/langchain-command-edit --patches-dir patches
pnpm install --no-frozen-lockfile --ignore-scripts
pnpm install --frozen-lockfile --ignore-scripts
```

Verify `step-budget-full-stack.test.ts` with the installed SDK, including
pressure-triggered native summarization, v3 streaming, native approval and
saved-decision recovery, plus the distinct-Command conflict negative case.
Run the other budget/governance tests, backend type checks and full tests;
verify frozen installation and Docker prune retain the patch. Reload already
running API/worker processes before the real report loop, since relinking a
package does not replace modules already loaded in memory.

## Deep Agents child approval middleware composition

`deepagents@1.13.1` reuses an explicitly supplied
`HumanInTheLoopMiddleware` when constructing custom and implicit general-purpose
children, instead of appending a second middleware with the same name. Root
agent construction already supports replacing this named native middleware;
child construction must honor the same composition when the host preserves
the original approval map while guarding checkpoint-only preparation steps.

The ESM and CommonJS runtime chunks are patched. A child with no supplied
approval middleware still receives the original native middleware and original
`interruptOn` map. This patch does not disable approvals, change filesystem
permissions, accept an undocumented disable sentinel, or alter subagent tools.
Review/remove the patch when adopting an upstream version with equivalent
child middleware composition.

Use the standard `pnpm patch deepagents@1.13.1` workflow followed by explicit
non-frozen and frozen installs with `--ignore-scripts`. Verify the installed
SDK's actual general-purpose child approval fixture in
`step-budget-full-stack.test.ts`, including the last normal preparation step,
real approval/resume and closing. Keep the complete root/child budget, saved-AI
replay, read-only scope and native approval tests; do not validate only the
root agent or replace approval with an unconditional allow.

## Deep Agents filesystem failure receipts

The same `deepagents@1.13.1` patch makes `read_file`, `write_file` and `edit_file` use
the SDK's existing `toolError` helper when their backend returns `error`.
Returning the error as an ordinary text block or bare string causes the native ToolNode to
label a failed operation `status: success`; this was reproduced by the
real report loop and by installed-SDK regression tests.

Both ESM and CommonJS preserve the exact error content, tool name and call ID
while returning `status: error`, matching the existing permission and delete
error branches. Successful reads/writes/edits and their state updates are unchanged.
Run `filesystem-backend-errors-sdk.test.ts`, the full budget/governance SDK
fixtures, and the sandbox backend tests before refreshing this patch.

## macOS sandbox proxy endpoint

`@anthropic-ai__sandbox-runtime@0.0.81.patch` applies to the existing pinned
SourceWeft runtime tarball. For the owned, authenticated macOS HTTP/SOCKS mux
only, generated proxy endpoints use `127.0.0.1`, matching the IPv4 listener,
instead of relying on `localhost` address-family resolution inside Seatbelt.
Ports, proxy credentials, `NO_PROXY`, target-address policy and sandbox rules
are unchanged. External proxy settings, SOCKS-only configuration, Linux and
Windows keep their original behavior.

Run `apps/desktop/sandbox-sidecar/tests/proxy-endpoint.test.ts` against the
installed package and retain the original real macOS sandbox CI assertions.
Local passes do not substitute for that CI verification. Refs #427.
