export {
  discourseConnectorContribution,
  DISCOURSE_FORUM_URL_PATTERN,
  DISCOURSE_ID_PATTERN,
  DISCOURSE_CATEGORY_ID_PATTERN,
} from "./contribution";
export { builtinDiscourseConnectorCapabilityManifest } from "./manifest";
export { toBackendDiscourseManifest } from "./backend-manifest";
export { createConnectorAdapters } from "./host-services";
export {
  PAGE_SIZE_ASSUMED,
  MAX_TOPICS_PER_CATEGORY,
  MAX_TOPICS,
  MAX_REQUESTS,
  SCAN_TIMEOUT_MS,
  MAX_POSTS_PER_TOPIC,
  POST_BATCH,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_GAP_MS,
  MAX_SELECTED_ITEMS,
  MAX_TEXT_CHARS,
  MAX_METADATA_POST_IDS,
  MAX_METADATA_AUTHORS,
  DISCOURSE_USER_AGENT,
} from "./limits";
export { DiscourseError, type DiscourseErrorCode } from "./errors";
export { parseForumUrl, topicUrl, postUrl, safeSlug } from "./forum-url";
export {
  createDiscourseClient,
  isNotFound,
  DiscourseNotFound,
  type CreateDiscourseClientInput,
  type ClientLimits,
  type DiscourseClient,
} from "./client";
export {
  parseSite,
  parseCategory,
  parseTopicRow,
  parseTopic,
  parsePost,
  parseCategoryPage,
  parseTopicPosts,
  parseSearch,
  buildCategoryTree,
  isVisiblePost,
  lightHashOf,
  deepHashOf,
  toConnectorItem,
  type CategoryTree,
  type RefreshMode,
  type ToConnectorItemInput,
  type DiscourseSite,
  type DiscourseCategory,
  type DiscourseTopicRow,
  type DiscourseTopic,
  type DiscoursePost,
  type DiscourseSearchPost,
  type DiscourseCategoryPage,
  type DiscourseSearchResult,
} from "./model";
export { postHtmlToText } from "./post-text";
export { renderTopicMarkdown, type RenderTopicInput } from "./render";
