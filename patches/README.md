# Model SDK patches

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
`local-llm-no-auth.test.ts` for config sync, real HTTP, database credentials and
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
