export {
  editFileAgentTool,
  filesystemAgentToolDefs,
  globAgentTool,
  grepAgentTool,
  lsAgentTool,
  readFileAgentTool,
  writeFileAgentTool,
} from "./agent-tool-defs";

export const builtinVfsCapability = {
  id: "sourceweft/vfs",
} as const;

export {
  buildChunkFilePath,
  buildVirtualSource,
  buildVirtualSourceTree,
  findVirtualSource,
  normalizeVirtualPath,
  parseVirtualPath,
  safeVirtualName,
  type BuildVirtualSourceInput,
} from "./paths";
export {
  buildEditFileToolDescription,
  buildFilesystemMountPrompt,
  buildFilesystemToolDescriptions,
  buildGlobToolDescription,
  buildGrepToolDescription,
  buildLsToolDescription,
  buildReadFileToolDescription,
  buildWriteFileToolDescription,
  createDefaultFilesystemMounts,
  KB_READ_FILE_DEFAULT_LINE_LIMIT,
  KB_READ_FILE_MAX_LINE_LIMIT,
  KNOWLEDGE_MOUNT,
  SKILLS_MOUNT,
  WORK_MOUNT,
  type AgentFilesystemMountCapability,
  type AgentFilesystemPromptOptions,
  type FilesystemEvidenceRole,
} from "./filesystem-capabilities";
export { MountedAgentFilesystemBackend } from "./mounted-backend";
export type {
  VirtualFsChunk,
  VirtualFsDocument,
  VirtualFsGrepCandidate,
  VirtualFsSource,
  VirtualPathTarget,
} from "./types";
