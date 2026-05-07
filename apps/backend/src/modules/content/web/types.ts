export type WebProviderName = "anycrawl" | string;

export type WebSearchProviderInput = {
  query: string;
  limit: number;
  includeContent?: boolean;
  fresh?: boolean;
  lang?: string;
  country?: string;
};

export type WebSearchProviderResult = {
  provider: WebProviderName;
  query: string;
  count: number;
  results: WebSearchResultItem[];
};

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet?: string;
  markdown?: string;
  wordCount?: number;
  truncated?: boolean;
  publishedAt?: string;
  source?: string;
};

export type WebFetchProviderInput = {
  fresh?: boolean;
  items: Array<{
    url: string;
    prompt?: string;
  }>;
};

export type WebFetchProviderResult = {
  provider: WebProviderName;
  count: number;
  results: WebFetchResultItem[];
};

export type WebFetchResultItem = {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
  wordCount: number;
  truncated: boolean;
  error?: string;
};

export type WebProvider = {
  name: WebProviderName;
  search(input: WebSearchProviderInput): Promise<WebSearchProviderResult>;
  fetch(input: WebFetchProviderInput): Promise<WebFetchProviderResult>;
};
