import type { StructuredToolInterface } from "@langchain/core/tools";

export type WebToolRuntime = StructuredToolInterface;

export type WebProviderName = "anycrawl" | string;

export type WebSearchProviderInput = {
  readonly query: string;
  readonly limit: number;
  readonly includeContent?: boolean;
  readonly fresh?: boolean;
  readonly lang?: string;
  readonly country?: string;
};

export type WebSearchResultItem = {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly markdown?: string;
  readonly wordCount?: number;
  readonly truncated?: boolean;
  readonly publishedAt?: string;
  readonly source?: string;
};

export type WebSearchProviderResult = {
  readonly provider: WebProviderName;
  readonly query: string;
  readonly count: number;
  readonly results: readonly WebSearchResultItem[];
};

export type WebFetchProviderInputItem = {
  readonly url: string;
  readonly prompt?: string;
};

export type WebFetchProviderInput = {
  readonly fresh?: boolean;
  readonly items: readonly WebFetchProviderInputItem[];
};

export type WebFetchResultItem = {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly markdown: string;
  readonly wordCount: number;
  readonly truncated: boolean;
  readonly error?: string;
};

export type WebFetchProviderResult = {
  readonly provider: WebProviderName;
  readonly count: number;
  readonly results: readonly WebFetchResultItem[];
};

export type WebProvider = {
  readonly name: WebProviderName;
  search(input: WebSearchProviderInput): Promise<WebSearchProviderResult>;
  fetch(input: WebFetchProviderInput): Promise<WebFetchProviderResult>;
};

export type WebExternalCitationInput = {
  readonly origin: string;
  readonly externalUri: string;
  readonly sourceTitle?: string | null;
  readonly content: string;
  readonly excerptContent?: string;
  readonly fullContent?: string;
  readonly score?: number | null;
};

export type WebExternalCitation = {
  readonly citation: string;
};

export type WebCitationRegistry = {
  addExternal(input: WebExternalCitationInput): WebExternalCitation;
};

export type CreateWebToolsInput = {
  readonly provider: WebProvider;
  readonly citationRegistry: WebCitationRegistry;
  readonly searchEnabled?: boolean;
};
