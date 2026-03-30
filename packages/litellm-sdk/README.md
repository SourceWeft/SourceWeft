# @polyer/litellm-sdk

Internal LiteLLM-first SDK for VelaMind.

This package provides:

- Core client APIs for `chat`, `embeddings`, and `rerank`
- LiteLLM compatibility normalization (tool choice, usage, provider fields)
- Streaming event normalization
- LangChain adapters (`ChatLiteLLM`, `LiteLLMEmbeddings`, router variants)

All app-side model traffic should go through this package and LiteLLM aliases:

- `chat-default`
- `embed-default`
- `rerank-default`
