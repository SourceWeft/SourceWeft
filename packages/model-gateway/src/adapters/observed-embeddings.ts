import { AzureOpenAIEmbeddings, OpenAIEmbeddings } from "@langchain/openai";
import { captureEmbeddingResponse } from "../observation/embedding-capture";

// Both installed SDK classes publicly declare this protected extension point.
// super owns retry, batching, response parsing and vector decoding; record only
// after its successful return, and return the exact same response object.
export class ObservedOpenAIEmbeddings extends OpenAIEmbeddings {
  protected override async embeddingWithRetry(
    request: Parameters<OpenAIEmbeddings["embeddingWithRetry"]>[0],
  ): ReturnType<OpenAIEmbeddings["embeddingWithRetry"]> {
    const response = await super.embeddingWithRetry(request);
    captureEmbeddingResponse({
      inputTokens: response.usage?.prompt_tokens,
      totalTokens: response.usage?.total_tokens,
      requestId: response._request_id,
    });
    return response;
  }
}

export class ObservedAzureOpenAIEmbeddings extends AzureOpenAIEmbeddings {
  protected override async embeddingWithRetry(
    request: Parameters<AzureOpenAIEmbeddings["embeddingWithRetry"]>[0],
  ): ReturnType<AzureOpenAIEmbeddings["embeddingWithRetry"]> {
    const response = await super.embeddingWithRetry(request);
    captureEmbeddingResponse({
      inputTokens: response.usage?.prompt_tokens,
      totalTokens: response.usage?.total_tokens,
      requestId: response._request_id,
    });
    return response;
  }
}
