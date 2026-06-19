/**
 * Shared tool-name string constants.
 *
 * These are plain `const` declarations so every builtin package and the
 * agent-tool-registry can reference them without circular imports.
 * Each constant is the `name` field from the corresponding AgentToolDefinition.
 */

/** Filesystem */
export const LS_TOOL_NAME = "ls" as const;
export const READ_FILE_TOOL_NAME = "read_file" as const;
export const GLOB_TOOL_NAME = "glob" as const;
export const GREP_TOOL_NAME = "grep" as const;
export const WRITE_FILE_TOOL_NAME = "write_file" as const;
export const EDIT_FILE_TOOL_NAME = "edit_file" as const;

/** Web */
export const WEB_FETCH_TOOL_NAME = "web_fetch" as const;
export const WEB_SEARCH_TOOL_NAME = "web_search" as const;

/** Retrieval */
export const SEARCH_SOURCES_TOOL_NAME = "search_sources" as const;

/** Sandbox */
export const PREPARE_SANDBOX_TOOL_NAME = "prepare_sandbox_workspace" as const;
export const EXECUTE_TOOL_NAME = "execute" as const;
export const COLLECT_SANDBOX_OUTPUTS_TOOL_NAME = "collect_sandbox_outputs" as const;

/** Artifacts */
export const GENERATE_IMAGE_TOOL_NAME = "generate_image" as const;
export const PUBLISH_ARTIFACT_TOOL_NAME =
  "publish_artifact" as const;
export const GENERATE_VIDEO_PRESENTATION_TOOL_NAME = "generate_video_presentation" as const;

/** Notion Connector */
export const SEARCH_NOTION_PAGES_TOOL_NAME = "search_notion_pages" as const;
export const READ_NOTION_PAGE_TOOL_NAME = "read_notion_page" as const;
export const CREATE_NOTION_PAGE_TOOL_NAME = "create_notion_page" as const;
export const APPEND_NOTION_PAGE_TOOL_NAME = "append_notion_page" as const;
export const UPDATE_NOTION_PAGE_TOOL_NAME = "update_notion_page" as const;
export const DELETE_NOTION_PAGE_TOOL_NAME = "delete_notion_page" as const;
export const SAVE_ARTIFACT_TO_NOTION_TOOL_NAME = "save_artifact_to_notion" as const;
export const SAVE_FINAL_ANSWER_TO_NOTION_TOOL_NAME = "save_final_answer_to_notion" as const;
