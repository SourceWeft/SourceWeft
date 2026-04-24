# Integration Tests

These tests exercise `@sourceweft/model-gateway` against real upstream providers.

- No LiteLLM service is involved.
- No local HTTP server is involved.
- `chat` and `embeddings` run through the package's LangChain bridge.
- `rerank` hits the provider HTTP endpoint directly through the package.

## Environment

Set the provider keys you want to use before running the suite.

```bash
export OPENROUTER_API_KEY="..."
export OPENROUTER_API_BASE="https://openrouter.ai/api/v1"

export DEEPINFRA_API_KEY="..."
export DEEPINFRA_API_BASE="https://api.deepinfra.com/v1/openai"
```

`OPENROUTER_API_BASE` and `DEEPINFRA_API_BASE` are optional. The defaults above are used when omitted.

## Coverage

- Real OpenRouter chat completion and streaming with `minimax/minimax-m2.7`
- Real OpenRouter rerank with `cohere/rerank-4-pro`
- Real DeepInfra embeddings with `BAAI/bge-m3`
- Mocked failure scenarios where real providers are not deterministic enough to trigger on demand

## Run

```bash
pnpm test:integration
```
